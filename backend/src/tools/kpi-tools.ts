import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { IrisServices } from '../iris/index.js';
import type { KpiDefinition } from '../kpi/kpi-definition.model.js';
import { ok, fail, guard } from './result.js';

/**
 * Agent-mode KPI tools. Unlike cubes (which the agent generates + compiles +
 * builds via Atelier/Native), a KPI is created by POSTing a definition to SCO's
 * Business KPI REST API — the SAME endpoints the Angular workbench uses
 * (`SC.Core.API.KPI.KpiApiImpl`). So these tools call `iris.kpi` (KpiRestClient)
 * rather than reinventing the %JSONImport/%Save.
 *
 * Read-only: sco_list_kpis, sco_get_kpi. State-changing (confirmation-gated in
 * the permission layer): sco_create_kpi, sco_update_kpi, sco_delete_kpi.
 *
 * In Guided mode these are all denied (guided teaches via the ui_* tools and
 * never touches IRIS); the permission gate enforces that.
 */

// Zod schema mirroring the KpiDefinition model (see kpi-definition.model.ts).
// Kept aligned with SC.Core.Analytics.KPI.KpiDefinition / DeepseeKpiSpec.
const kpiDimensionSchema = z.object({
  name: z.string().describe('Short filter/param name, e.g. "carrier".'),
  label: z.string().optional().describe('Display label.'),
  cubeDimension: z.string().optional().describe('MDX cube dimension, e.g. "[carrier].[H1].[name]".'),
});

const deepseeKpiSpecSchema = z.object({
  namespace: z.string().optional().describe('SCO namespace; omit to use the configured one.'),
  cube: z.string().describe('DeepSee cube the KPI reads (required), e.g. "SalesOrderCube".'),
  kpiMeasure: z
    .string()
    .optional()
    .describe('Cube measure aggregated by the KPI. Use "%COUNT" for a row count, or a named measure.'),
  valueType: z.enum(['raw', 'percentage']).describe('raw (a count/measure) or percentage (numerator/denominator).'),
  kpiConditions: z
    .array(z.string())
    .optional()
    .describe('MDX numerator filters, e.g. "[status].[H1].[status].&[Open]". At least one required to submit.'),
  baseConditions: z
    .array(z.string())
    .optional()
    .describe('MDX denominator filters — ONLY for a percentage KPI.'),
  kpiDimensions: z.array(kpiDimensionSchema).optional().describe('Breakdown / drill-down dimensions.'),
});

const kpiDefinitionSchema = z.object({
  name: z.string().describe('Unique KPI name (no spaces), the key SCO stores it under.'),
  label: z.string().optional().describe('Human display name.'),
  description: z.string().optional(),
  type: z.string().optional().describe('KPI type; use "DeepSee" (the only type the Workbench authors).'),
  baseObject: z
    .string()
    .optional()
    .describe('Drill-through source object short-name; resolves to SC.Core.API.Data.{baseObject}ApiImpl.'),
  status: z.string().optional().describe('"Active" or "Inactive".'),
  watchingThreshold: z.number().optional().describe('Yellow alert level.'),
  warningThreshold: z.number().optional().describe('Red alert level.'),
  issueKpi: z.boolean().optional().describe('Whether crossing a threshold raises an Issue per impacted record.'),
  defaultIssueSeverity: z.number().int().optional().describe('1–5 (1 = most critical); only when issueKpi is true.'),
  analysisService: z.string().optional().describe('BPL service for issue resolution; only when issueKpi is true.'),
  deepseeKpiSpec: deepseeKpiSpecSchema.optional().describe('The cube-backed spec; required for a DeepSee KPI.'),
});

export function kpiTools(iris: IrisServices) {
  // Read-only: list every KPI definition (names + specs).
  const list = tool(
    'sco_list_kpis',
    'List all Business KPI definitions in SCO (via the SCO KPI REST API). Read-only. Use to check what already exists before creating one (a KPI name must be unique).',
    {},
    async () =>
      guard(async () => {
        const kpis = await iris.kpi.list();
        // Return a compact index; the full spec is available via sco_get_kpi.
        const summary = kpis.map((k) => ({
          name: k.name,
          label: k.label,
          cube: k.deepseeKpiSpec?.cube,
          measure: k.deepseeKpiSpec?.kpiMeasure,
          valueType: k.deepseeKpiSpec?.valueType,
          issueKpi: k.issueKpi ?? false,
        }));
        return ok({ count: summary.length, kpis: summary });
      }),
    { annotations: { title: 'List KPIs', readOnlyHint: true } },
  );

  // Read-only: read one KPI definition back in full.
  const get = tool(
    'sco_get_kpi',
    'Get one Business KPI definition by name, in full (thresholds, cube spec, conditions, dimensions). Read-only.',
    { name: z.string().describe('The KPI name.') },
    async ({ name }) =>
      guard(async () => {
        const kpi = await iris.kpi.get(name);
        if (!kpi) return fail(`KPI "${name}" was not found in SCO.`, { name, exists: false });
        return ok({ kpi });
      }),
    { annotations: { title: 'Get KPI', readOnlyHint: true } },
  );

  // State-changing: create a new KPI definition in IRIS.
  const create = tool(
    'sco_create_kpi',
    'Create a new Business KPI definition in SCO via the SCO KPI REST API. Changes the SCO instance. SCO rejects a name that already exists — check with sco_list_kpis first. A DeepSee KPI needs deepseeKpiSpec.cube, valueType, and at least one kpiConditions entry; baseConditions apply only when valueType is "percentage".',
    { definition: kpiDefinitionSchema },
    async ({ definition }) =>
      guard(async () => {
        const problem = validateForCreate(definition as KpiDefinition);
        if (problem) return fail(problem);
        const created = await iris.kpi.create(definition as KpiDefinition);
        return ok({ name: created.name, kpi: created, message: `KPI "${created.name}" created.` });
      }),
    { annotations: { title: 'Create KPI', readOnlyHint: false } },
  );

  // State-changing: update an existing KPI definition (keyed by original name).
  const update = tool(
    'sco_update_kpi',
    'Update an existing Business KPI definition in SCO via the SCO KPI REST API. Changes the SCO instance. `name` is the CURRENT (original) name SCO keys by; a rename puts the new name inside `definition`. Read the current definition with sco_get_kpi first so you send a complete, corrected definition.',
    {
      name: z.string().describe('The current (original) KPI name to update — the API keys by this.'),
      definition: kpiDefinitionSchema,
    },
    async ({ name, definition }) =>
      guard(async () => {
        const problem = validateForCreate(definition as KpiDefinition);
        if (problem) return fail(problem);
        const updated = await iris.kpi.update(name, definition as KpiDefinition);
        return ok({ name: updated.name, kpi: updated, message: `KPI "${name}" updated.` });
      }),
    { annotations: { title: 'Update KPI', readOnlyHint: false } },
  );

  // State-changing: delete a KPI definition.
  const remove = tool(
    'sco_delete_kpi',
    'Delete a Business KPI definition from SCO via the SCO KPI REST API. Changes the SCO instance. This permanently removes the definition.',
    { name: z.string().describe('The KPI name to delete.') },
    async ({ name }) =>
      guard(async () => {
        await iris.kpi.delete(name);
        return ok({ name, message: `KPI "${name}" deleted.` });
      }),
    { annotations: { title: 'Delete KPI', readOnlyHint: false } },
  );

  return [list, get, create, update, remove];
}

/**
 * Client-side validation mirroring what IRIS requires (KpiApiImpl.%JSONImport +
 * DeepseeKpiSpec's Required fields), so an obviously-incomplete definition fails
 * with a clear message before the round-trip rather than a raw IRIS 400.
 */
function validateForCreate(def: KpiDefinition): string | null {
  if (!def.name?.trim()) return 'KPI `name` is required.';
  const type = def.type ?? 'DeepSee';
  if (type === 'DeepSee') {
    const spec = def.deepseeKpiSpec;
    if (!spec) return 'A DeepSee KPI requires a `deepseeKpiSpec` (cube, valueType, kpiConditions).';
    if (!spec.cube?.trim()) return '`deepseeKpiSpec.cube` is required.';
    if (!spec.valueType) return '`deepseeKpiSpec.valueType` is required ("raw" or "percentage").';
    if (!spec.kpiConditions?.length) return 'A KPI needs at least one `deepseeKpiSpec.kpiConditions` entry.';
    if (spec.valueType === 'percentage' && !spec.baseConditions?.length) {
      return 'A percentage KPI needs at least one `deepseeKpiSpec.baseConditions` entry (the denominator).';
    }
  }
  return null;
}
