// backend/src/dashboard/humanize-label.ts
//
// The backend twin of the frontend presentational humanizer
// (frontend/src/app/dashboard/humanize.ts::humanizeField). Kept in lockstep so a
// chart TITLE / axis label built here reads identically to the dimension DROPDOWN
// the frontend humanizes. Pure and dependency-free.
//
// Display-ONLY: the raw identifier is still the value sent in the MDX query and
// carried in ChartData; only the human titling label changes. Applied by the cube
// source to raw dimension codes and un-captioned measure names — an AUTHORED cube
// caption is passed through verbatim by the caller and never routed here.

/**
 * Acronyms kept fully upper-case rather than Title-cased (lockstep with the FE
 * allow-list `humanize.ts::ACRONYMS`). The shared fixture `ci/humanize-lockstep.json`
 * guards the two sets against drift: both specs assert this set equals the fixture's,
 * so an acronym added to one humanizer but not the other fails a test.
 */
export const ACRONYMS = new Set(['UID', 'ID', 'URL', 'SCAC', 'SLA', 'BOM', 'KPI']);

/**
 * A raw field/dimension identifier → human Title Case. Splits camelCase and
 * `_`/`.`-delimited names into words; allow-listed acronyms stay upper-case; an
 * already-spaced label is returned unchanged (idempotent).
 */
export function humanizeLabel(name: string): string {
  if (!name) return name;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/[_.]+/g, ' ')                  // _ and . delimiters
    .trim()
    .split(/\s+/);
  return words
    .map((w) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}
