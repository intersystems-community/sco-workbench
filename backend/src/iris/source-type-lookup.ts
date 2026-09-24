/**
 * The SCO-backed SourceTypeLookup for the measure type check: a source class's
 * property types, and the return types of the helper methods expressions call.
 * Read-only, over the Atelier SQL endpoint.
 */
import { listMethods, listProperties, type SqlQuerier } from './schema-ops.js';
import type { SourceTypeLookup } from '../cube/measure-source-types.js';

export async function sourceTypeLookup(q: SqlQuerier, sourceClass: string): Promise<SourceTypeLookup> {
  const propertyTypes = new Map((await listProperties(q, sourceClass)).map((p) => [p.name, p.type]));
  return {
    propertyType: (name) => propertyTypes.get(name) || undefined,
    methodReturnType: async (className, method) =>
      (await listMethods(q, className)).find((m) => m.name === method)?.returnType || undefined,
  };
}
