import type { AtelierClient } from '../iris/atelier-client.js';

/**
 * List the valid KPI "base objects".
 *
 * A KPI's `baseObject` is a SHORT name that SCO concatenates into the class name
 * `SC.Core.API.Data.{baseObject}ApiImpl` (see SC.Core.Util.ApiImplUtil), which
 * backs the KPI's drill-through "Related Records" listing. So the set of valid
 * base objects is exactly the set of `*ApiImpl` classes that exist under
 * `SC.Core.API.Data.*` — we query the class dictionary and strip the prefix and
 * `ApiImpl` suffix to recover each short name.
 *
 * Read-only; no Workbench class is installed in IRIS.
 */

const PREFIX = 'SC.Core.API.Data.';
const SUFFIX = 'ApiImpl';

export async function listKpiBaseObjects(atelier: AtelierClient): Promise<string[]> {
  const rows = await atelier.query<{ Name?: string }>(
    "SELECT Name FROM %Dictionary.CompiledClass " +
      "WHERE Name LIKE 'SC.Core.API.Data.%ApiImpl' ORDER BY Name",
  );
  return rows
    .map((r) => r.Name)
    .filter((n): n is string => typeof n === 'string' && n.startsWith(PREFIX) && n.endsWith(SUFFIX))
    .map((n) => n.slice(PREFIX.length, n.length - SUFFIX.length))
    .filter((short) => short.length > 0);
}
