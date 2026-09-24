import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { IrisServices } from '../iris/index.js';
import { resolveClass, listProperties, listMethods, listForeignKeys } from '../iris/schema-ops.js';
import {
  generateIntegrationClasses,
  generateConfigItems,
  validateIntegrationDefinition,
  sanitizeIntegrationName,
  integrationClassNames,
} from '../integration/integration-generator.js';
import type { IntegrationDefinition } from '../integration/integration-definition.model.js';
import { ok, fail, guard } from './result.js';

/**
 * Zod schema for the deploy payload. Permissive on the service object (the fields
 * that matter depend on the adapter) but strict on the mapping shape, which drives
 * the generated message/DTL.
 */
const mappingSchema = z.object({
  sourceField: z.string(),
  sourceType: z
    .enum(['string', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'time', 'stream'])
    .optional(),
  transform: z
    .enum(['', 'ToUpper', 'ToLower', 'Length', 'SubString', 'ReplaceStr', 'Strip', 'Pad', 'ConvertDateTime', 'Piece', 'Lookup'])
    .nullable()
    .optional(),
  transformArgs: z.record(z.string(), z.string()).optional(),
  targetProperty: z.string(),
});

const definitionSchema = z.object({
  id: z.string().describe('Integration id — namespaces every class as SC.Workbench.Integration{id}.*.'),
  name: z.string().describe('Display name; sanitized to a legal identifier for the class-name segment.'),
  adapter: z.enum(['File', 'FTP', 'SFTP', 'Cloud', 'SQL']),
  service: z.looseObject({}).describe('Adapter source config (filePath/fileSpec, host/path/credentials, bucket, dsn/query, …).'),
  process: z.object({
    hasHeader: z.boolean(),
    targetClass: z.string().describe('Fully-qualified existing SCO target class, e.g. SC.Data.Customer.'),
    mappings: z.array(mappingSchema).min(1),
  }),
});

/**
 * Read-only tool that DETERMINISTICALLY generates a data-integration pipeline's
 * IRIS classes from the deploy payload. The agent does NOT author any
 * ObjectScript — this tool owns the class structure, so the recurring
 * generation bugs (stray Storage block, %CSV.Reader, a <call> to the DTL, an
 * undeclared context property, create="new", a guessed config-item setting)
 * cannot occur.
 *
 * It performs the one piece of real introspection the payload can't carry —
 * resolving the target class and finding its key index's Open method for the
 * upsert — then returns: the ordered class sources to compile, and the ordered
 * production config-item specs to register (all disabled). Touches IRIS only via
 * read-only schema queries.
 */
export function integrationTools(iris: IrisServices) {
  const generate = tool(
    'sco_generate_integration_classes',
    'Deterministically generate ALL ObjectScript classes for a data-integration pipeline (request message, DTL, BPL process, and — for File/FTP/SFTP/Cloud — the Business Service) from the deploy payload, plus the exact production config-item specs to register. Does NOT author source by hand and does NOT change SCO (read-only: it resolves the target class and its key index). Returns { integrationName, classNames, classes[] (role, className, source — in compile order; source is null for the SQL Business Service), configItems[] (add order, all to be added DISABLED), keyIndex/keyRequestProp, foreignKeys[] (target FKs this pipeline writes — referenced parent rows must pre-exist or rows are skipped with #5829), warnings[] }. Compile each class with sco_compile_class in the given order, then register each configItem with sco_add_config_item, then enable BP first and the service last. RELAY every warnings[] entry to the user (especially the foreign-key prerequisites).',
    { definition: definitionSchema },
    async ({ definition }) =>
      guard(async () => {
        const def = definition as unknown as IntegrationDefinition;
        const warnings: string[] = [];

        // 1. Resolve the target class (accepts a SQL table name too) so we generate
        //    against the REAL compiled class name, not what the user typed.
        const resolved = await resolveClass(iris.atelier, def.process.targetClass);
        if (!resolved.exists || !resolved.className) {
          return fail(
            `Target class "${def.process.targetClass}" was not found in SCO.`,
            { candidates: resolved.candidates ?? [] },
          );
        }
        def.process = { ...def.process, targetClass: resolved.className };

        // 2. Verify every mapped target property exists on the class (fail loud —
        //    a typo'd target property breaks the DTL compile with <CLASS DOES NOT EXIST>).
        const props = await listProperties(iris.atelier, resolved.className);
        const propNames = new Set(props.map((p) => p.name));
        const missing = def.process.mappings
          .map((m) => m.targetProperty?.trim())
          .filter((p): p is string => !!p && !propNames.has(p));
        if (missing.length) {
          return fail(
            `These target properties do not exist on ${resolved.className}: ${missing.join(', ')}. ` +
              `Fix the mapping (use sco_match_property to find the right names) and retry.`,
            { targetClass: resolved.className, availableProperties: [...propNames] },
          );
        }

        // 3. Find the key index for the upsert: pick the mapping whose targetProperty
        //    is a natural key (uid/id) and confirm its <prop>Index has an Open method.
        //    Gate on the METHOD's existence, not the index's unique flag (SCO's
        //    SC.Data.* key indices generate <index>Open even when non-unique).
        const keyInfo = await resolveKeyIndex(iris, resolved.className, def);
        if (keyInfo) {
          def.keyIndex = keyInfo.keyIndex;
          def.keyRequestProp = keyInfo.keyRequestProp;
        } else {
          def.keyIndex = undefined;
          def.keyRequestProp = undefined;
          warnings.push(
            'No key-index Open method found on the target, so the pipeline is INSERT-ONLY: ' +
              're-running it will duplicate rows (the target has no natural-key index to upsert on).',
          );
        }

        // 4. Detect the target's foreign keys and WARN. An FK is a data
        //    prerequisite: every referenced value must already exist in the
        //    referenced (parent) table, or `%Save()` fails with `#5829` and that
        //    record is skipped. This is adapter-independent (any source hits it),
        //    the user controls it (load the parent data first), and we cannot
        //    loosen the target class. Surfacing it here turns silent `Skipped
        //    request` errors into an up-front, actionable heads-up.
        const foreignKeys = await listForeignKeys(iris.atelier, resolved.className);
        const mappedTargets = new Set(def.process.mappings.map((m) => m.targetProperty?.trim()).filter(Boolean));
        // Only warn about FK columns this pipeline actually writes — an unmapped FK
        // column is never set, so it can't fail (it stays null/default).
        const relevantFks = foreignKeys.filter((fk) => fk.columns.some((c) => mappedTargets.has(c)));
        for (const fk of relevantFks) {
          warnings.push(
            `Target ${resolved.className} has a foreign key (${fk.name}) on ${fk.columns.join(', ')} → ${fk.referencedClass}: ` +
              `each source value for ${fk.columns.join('/')} must already exist as a row in ${fk.referencedClass}, ` +
              `or that record is SKIPPED at save with "#5829 Foreign Key constraint failed". Load ${fk.referencedClass} first.`,
          );
        }
        // Thread the relevant FKs into the definition (mapping each FK target column
        // back to the SOURCE field that carries it) so the generated BPL's skip log
        // can name the exact missing reference + value on a #5829.
        const sourceFor = new Map(
          def.process.mappings
            .filter((m) => m.targetProperty?.trim() && m.sourceField?.trim())
            .map((m) => [m.targetProperty!.trim(), m.sourceField.trim()]),
        );
        def.foreignKeys = relevantFks.map((fk) => ({
          name: fk.name,
          referencedClass: fk.referencedClass,
          sourceFields: fk.columns.map((c) => sourceFor.get(c) ?? c).filter(Boolean),
        }));

        // 5. Validate the (now target-resolved) definition, then generate.
        const problems = validateIntegrationDefinition(def);
        if (problems.length) return fail(`Invalid integration definition:\n${problems.join('\n')}`, { problems });

        const integrationName = sanitizeIntegrationName(def.name);
        const classNames = integrationClassNames(String(def.id), integrationName);
        const classes = generateIntegrationClasses(def);
        const configItems = generateConfigItems(def);

        return ok({
          integrationName,
          classNames,
          keyIndex: def.keyIndex ?? null,
          keyRequestProp: def.keyRequestProp ?? null,
          classes,
          configItems,
          foreignKeys: relevantFks,
          warnings,
        });
      }),
    { annotations: { title: 'Generate integration classes', readOnlyHint: true } },
  );

  return [generate];
}

/**
 * Find the target's natural-key index and the request property carrying its
 * value, for the BPL upsert. Strategy: among the mapped fields, prefer a target
 * property named `uid` then `id`, else the first mapped property that has a
 * matching `<prop>Index` with a generated `<prop>IndexOpen` classmethod. Returns
 * null when no such Open method exists (→ insert-only).
 */
async function resolveKeyIndex(
  iris: IrisServices,
  className: string,
  def: IntegrationDefinition,
): Promise<{ keyIndex: string; keyRequestProp: string } | null> {
  const methods = await listMethods(iris.atelier, className);
  // Match `<index>Open` by NAME regardless of the dictionary's ClassMethod flag:
  // IRIS makes index accessors (`uidIndexOpen`) callable as `##class(Cls).uidIndexOpen(v)`
  // even though %Dictionary.CompiledMethod flags them as instance methods for a
  // custom (scmodel-generated) class — gating on isClassMethod wrongly rejected
  // them and fell back to insert-only. (Verified live on a custom SC.Data.* class.)
  const openMethods = new Set(methods.filter((m) => /Open$/.test(m.name)).map((m) => m.name));
  if (!openMethods.size) return null;

  // Candidate order: mapping onto uid, then id, then any other mapped property.
  const mapped = def.process.mappings.filter((m) => m.targetProperty?.trim() && m.sourceField?.trim());
  const preferred = ['uid', 'id'];
  const ordered = [
    ...mapped.filter((m) => preferred.includes(m.targetProperty.trim().toLowerCase())),
    ...mapped.filter((m) => !preferred.includes(m.targetProperty.trim().toLowerCase())),
  ];

  for (const m of ordered) {
    const prop = m.targetProperty.trim();
    // IRIS names the index for a key property `<prop>Index` by SCO convention.
    const indexName = `${prop}Index`;
    if (openMethods.has(`${indexName}Open`)) {
      return { keyIndex: indexName, keyRequestProp: m.sourceField.trim() };
    }
  }
  return null;
}
