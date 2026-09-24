import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { IrisServices } from '../iris/index.js';
import { resolveClass, listProperties, listMethods, matchProperty } from '../iris/schema-ops.js';
import { suggestDimensionSources } from '../iris/dimension-suggest.js';
import { ok, guard } from './result.js';

/** The SCO helper class whose getters reach through soft foreign keys. */
const HELPER_CLASS = 'SC.Core.Util.CubeUtil';

/**
 * Read-only IRIS schema introspection tools. The agent uses these to verify and
 * repair class/property names BEFORE generating a cube, avoiding the
 * compile-fail-guess loop (SQL table vs class name, wrong-case properties,
 * non-reference foreign keys). None change IRIS state, so they are NOT gated.
 */
export function schemaTools(iris: IrisServices) {
  const resolve = tool(
    'sco_resolve_class',
    'Resolve a source class name against the running SCO instance. Accepts either an ObjectScript class name (e.g. "SC.Data.SalesOrder") OR a SQL table name (e.g. "SC_Data.SalesOrder") and returns the real compiled class name. Use this FIRST to confirm the cube source class exists — SQL table names use underscores while ObjectScript class names use dots. Read-only.',
    { name: z.string().describe('A class name or SQL schema.table name to resolve.') },
    async ({ name }) =>
      guard(async () => {
        const r = await resolveClass(iris.atelier, name);
        return ok({ ...r });
      }),
    { annotations: { title: 'Resolve SCO class', readOnlyHint: true } },
  );

  const list = tool(
    'sco_list_properties',
    'List the properties of a compiled SCO class (name, type, and whether each is a reference to another class). Use this to confirm the exact property names/casing for cube dimensions and measures before generating the cube. A property whose isReference is true supports arrow traversal (e.g. "customer->name"); a plain %String foreign key does not. Read-only.',
    { className: z.string().describe('Fully-qualified ObjectScript class name (resolve it first if unsure).') },
    async ({ className }) =>
      guard(async () => {
        const properties = await listProperties(iris.atelier, className);
        return ok({ className, properties });
      }),
    { annotations: { title: 'List class properties', readOnlyHint: true } },
  );

  const methods = tool(
    'sco_list_methods',
    'List the callable methods of a compiled SCO class (name, signature, return type, and doc line; ClassMethods are callable as ##class(Class).Method(...)). Use this to find a real helper for a cube level sourceExpression — e.g. before inventing a foreign-key lookup, list SC.Core.Util.CubeUtil to see if a getter like getCustomerName(id) already exists. Read-only.',
    { className: z.string().describe('Fully-qualified ObjectScript class name (resolve it first if unsure).') },
    async ({ className }) =>
      guard(async () => {
        const classMethods = await listMethods(iris.atelier, className);
        return ok({ className, methods: classMethods });
      }),
    { annotations: { title: 'List class methods', readOnlyHint: true } },
  );

  const match = tool(
    'sco_match_property',
    'Check whether a requested property name exists on a class, and if not, return the closest real property names (ranked). Use this to repair a mistyped or wrong-case dimension/measure property before generating the cube — then confirm the suggested match with the user. Read-only.',
    {
      className: z.string(),
      requested: z.string().describe('The property name the user asked for (may be misspelled or wrong case).'),
    },
    async ({ className, requested }) =>
      guard(async () => {
        const r = await matchProperty(iris.atelier, className, requested);
        return ok({ ...r });
      }),
    { annotations: { title: 'Match property name', readOnlyHint: true } },
  );

  const dimensionSources = tool(
    'sco_suggest_dimension_sources',
    'Answer "what can this class be broken down BY?" in one call. Returns, for a source class: its scalar properties ' +
      '(a plain sourceProperty breakdown); its real object references (arrow traversal); and — the case you cannot work ' +
      'out from a property list alone — its SOFT FOREIGN KEYS (plain %String properties like siteLocationId that hold ' +
      "another record's uid, where arrow traversal does NOT work), each paired with the SC.Core.Util.CubeUtil getters " +
      'that can actually read through it, as paste-ready level sourceExpression strings. Also returns `unreachable`: ' +
      'foreign keys for which NO built-in getter exists. Call this whenever the user names a breakdown that is not a ' +
      'property of the source class ("by location", "by customer", "by product") — the related entity has several ' +
      'possible labels and only some are reachable, so use the returned list to ask the user which one they mean ' +
      'instead of guessing a property or inventing an expression. Read-only.',
    {
      className: z.string().describe('Fully-qualified source class of the cube (resolve it first if unsure).'),
    },
    async ({ className }) =>
      guard(async () => {
        const [properties, helpers] = await Promise.all([
          listProperties(iris.atelier, className),
          listMethods(iris.atelier, HELPER_CLASS),
        ]);
        return ok({ ...suggestDimensionSources(className, properties, helpers) });
      }),
    { annotations: { title: 'Suggest cube dimension sources', readOnlyHint: true } },
  );

  return [resolve, list, methods, match, dimensionSources];
}
