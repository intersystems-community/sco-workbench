import type { NativeClient } from './native-client.js';
import type { AtelierClient } from './atelier-client.js';
import type { DeepSeeClient, RawFilter } from './deepsee-client.js';
import type { CubeDefinition, DimensionType } from '../cube/cube-definition.model.js';
import { isWorkbenchCube } from '../cube/cube-generator.js';
import { parseCubeClass } from '../cube/cube-parser.js';

/**
 * Read-side cube catalog + full delete, complementing cube-ops.ts (build/info/kill).
 *
 * SCO does not provide a cube-management API, so cube CRUD goes straight to IRIS
 * BI (%DeepSee). We deliberately avoid the ByRef/Output array methods
 * (%GetCubeList, %GetDimensionList, …) because the Native SDK can only return
 * scalars — instead we:
 *   - LIST cubes by SQL-querying %Dictionary.CompiledClass for subclasses of
 *     %DeepSee.CubeDefinition (via the Atelier query endpoint we already use),
 *   - read each cube's SOURCE class from that same dictionary row (DependsOn),
 *   - and use the scalar %DeepSee.Utils calls that DO exist on the target IRIS
 *     (%GetCubeFactClass, %GetCubeFactCount, %CubeExists) for build state.
 *
 * All of this respects the hard constraint: no Workbench-specific classes are
 * installed in IRIS.
 */

export interface CubeSummary {
  /** Logical cube name (e.g. "SalesOrderCube"). */
  cubeName: string;
  /** Fully-qualified cube class (e.g. "SC.Core.Analytics.Cube.SalesOrder"). */
  className: string;
  /** Source class the cube reads from (the class's DependsOn), if known. */
  sourceClass?: string;
  /**
   * Whether the Workbench may edit/delete this cube. True only for cubes the
   * Workbench created (SC.Workbench.Cube.*); SCO's built-in cubes are read-only
   * here — they use Architect-only features the Workbench can't round-trip.
   */
  editable: boolean;
}

export interface CubeDetail extends CubeSummary {
  exists: boolean;
  factClass?: string;
  factCount?: number;
}

// ---- Full cube structure (from the D2CLIENT Info REST API) ----

export interface CubeMeasureInfo {
  name: string;
  caption?: string;
  type?: string;
  hidden?: boolean;
  factName?: string;
}

export interface CubeLevelInfo {
  /** Level name (the 3rd MDX segment, e.g. "Year"). */
  name: string;
  caption?: string;
  /** Level "type" from the filter (e.g. "year", "month"), when present. */
  type?: string;
  /** The full MDX spec, e.g. "[orderPlacedDate].[H1].[Year]". */
  spec: string;
  /**
   * Source property (the class field) or source expression — a level uses one
   * or the other. The D2CLIENT Info API doesn't expose either, so they're merged
   * in from the parsed class definition when available (both data dims and time
   * dims — a time dim's date field is shown on each level).
   */
  sourceProperty?: string;
  sourceExpression?: string;
}

export interface CubeHierarchyInfo {
  /** Hierarchy name (the 2nd MDX segment, e.g. "H1"). */
  name: string;
  levels: CubeLevelInfo[];
}

export interface CubeDimensionInfo {
  /** Dimension name (the 1st MDX segment, e.g. "orderPlacedDate"). */
  name: string;
  hierarchies: CubeHierarchyInfo[];
  /**
   * The dimension's DeepSee type ('time'/'age'/'data'/…), surfaced from the class
   * definition so the charting layer can tell a temporal axis from a categorical
   * one. Absent when no definition was available (built without the class parsed) —
   * consumers MUST treat absent as categorical, never as temporal.
   */
  type?: DimensionType;
}

export interface CubeListingInfo {
  name: string;
  fields?: string;
  order?: string;
  type?: string;
}

/** A cube's full structure, assembled from the read-only D2CLIENT Info API. */
export interface CubeStructure {
  measures: CubeMeasureInfo[];
  dimensions: CubeDimensionInfo[];
  listings: CubeListingInfo[];
}

export type CubeDetailFull = CubeDetail & Partial<CubeStructure>;

/**
 * List all cubes defined in the namespace by querying the class dictionary for
 * subclasses of %DeepSee.CubeDefinition. Returns the logical cube name, the
 * class name, and the source class (DependsOn). Excludes the base class itself.
 */
export async function listCubes(atelier: AtelierClient): Promise<CubeSummary[]> {
  const rows = await atelier.query<{ Name?: string; DependsOn?: string }>(
    "SELECT Name, DependsOn FROM %Dictionary.CompiledClass " +
      "WHERE PrimarySuper [ '~%DeepSee.CubeDefinition~' AND Name <> '%DeepSee.CubeDefinition' " +
      'ORDER BY Name',
  );
  return rows
    .filter((r): r is { Name: string; DependsOn?: string } => typeof r.Name === 'string' && r.Name.length > 0)
    .map((r) => ({
      className: r.Name,
      cubeName: shortCubeName(r.Name),
      sourceClass: firstDependsOn(r.DependsOn),
      editable: isWorkbenchCube(r.Name),
    }));
}

/**
 * Read one cube's detail: its source class (dictionary), plus live build state
 * from %DeepSee.Utils scalar calls. `cubeNameOrClass` may be the logical name
 * or the full class name.
 */
export async function cubeDetail(
  native: NativeClient,
  atelier: AtelierClient,
  cubeNameOrClass: string,
): Promise<CubeDetail> {
  // Resolve the real class name + source. A cube may live in EITHER package
  // (SCO's SC.Core.Analytics.Cube.* or ours SC.Workbench.Cube.*), so we can't
  // derive the class from a bare cube name — look it up in the dictionary.
  const resolved = await resolveCubeClass(atelier, cubeNameOrClass);
  const className = resolved?.className ?? cubeNameOrClass;
  const sourceClass = resolved?.sourceClass;
  const cubeName = shortCubeName(className);

  const exists = toBool(native.callValue('%DeepSee.Utils', '%CubeExists', cubeName));
  const detail: CubeDetail = { cubeName, className, sourceClass, exists, editable: isWorkbenchCube(className) };
  if (exists) {
    detail.factClass = safeString(native.callValue('%DeepSee.Utils', '%GetCubeFactClass', cubeName));
    detail.factCount = safeFactCount(native, cubeName);
  }
  return detail;
}

/**
 * Resolve a cube name-or-class to its real compiled class name + source class,
 * by querying the dictionary for a %DeepSee.CubeDefinition subclass whose name
 * matches (full class name, or short name in either cube package).
 */
async function resolveCubeClass(
  atelier: AtelierClient,
  cubeNameOrClass: string,
): Promise<{ className: string; sourceClass?: string } | null> {
  try {
    if (cubeNameOrClass.includes('.')) {
      const rows = await atelier.query<{ Name?: string; DependsOn?: string }>(
        'SELECT Name, DependsOn FROM %Dictionary.CompiledClass WHERE Name = ?',
        [cubeNameOrClass],
      );
      if (rows[0]?.Name) return { className: rows[0].Name, sourceClass: firstDependsOn(rows[0].DependsOn) };
      return { className: cubeNameOrClass };
    }
    // Bare cube name: match the class short-name across cube subclasses.
    const rows = await atelier.query<{ Name?: string; DependsOn?: string }>(
      "SELECT Name, DependsOn FROM %Dictionary.CompiledClass " +
        "WHERE PrimarySuper [ '~%DeepSee.CubeDefinition~' AND Name <> '%DeepSee.CubeDefinition'",
    );
    const hit = rows.find((r) => typeof r.Name === 'string' && shortCubeName(r.Name) === cubeNameOrClass);
    return hit?.Name ? { className: hit.Name, sourceClass: firstDependsOn(hit.DependsOn) } : null;
  } catch {
    return null; // best-effort; caller falls back to the given string
  }
}

/**
 * Read a Workbench cube's editable CubeDefinition by fetching its class source
 * and parsing the XData. Returns null if the cube isn't a Workbench cube
 * (SCO built-ins are not editable here) or the source can't be parsed.
 */
export async function readCubeDefinition(
  atelier: AtelierClient,
  cubeNameOrClass: string,
): Promise<CubeDefinition | null> {
  const resolved = await resolveCubeClass(atelier, cubeNameOrClass);
  const className = resolved?.className;
  if (!className || !isWorkbenchCube(className)) return null;
  const source = await atelier.readClass(className);
  if (!source) return null;
  return parseCubeClass(source);
}

/**
 * Parse ANY cube's class XData into a CubeDefinition for READ-ONLY display
 * (unlike readCubeDefinition, this does NOT restrict to Workbench cubes). Used
 * to enrich the detail view's dimension levels with their source
 * property/expression for SCO built-in cubes too. Never feeds the edit form.
 */
export async function readCubeDefinitionForDisplay(
  atelier: AtelierClient,
  cubeNameOrClass: string,
): Promise<CubeDefinition | null> {
  const resolved = await resolveCubeClass(atelier, cubeNameOrClass);
  const className = resolved?.className;
  if (!className) return null;
  try {
    const source = await atelier.readClass(className);
    return source ? parseCubeClass(source) : null;
  } catch {
    return null;
  }
}

/**
 * Delete a cube completely: drop its fact data (%KillCube) and THEN delete the
 * cube class definition ($SYSTEM.OBJ.Delete). Order matters — killing first,
 * while the fact class still exists, avoids orphaned fact globals.
 *
 * `className` must be the fully-qualified cube class. Deletion is refused unless
 * it's a Workbench cube (SC.Workbench.Cube.*) — SCO's built-in cubes are never
 * deleted through here. The route resolves the class name and guards first; this
 * is the defense-in-depth check.
 */
export function deleteCube(
  native: NativeClient,
  className: string,
): { ok: boolean; message: string } {
  if (!isWorkbenchCube(className)) {
    return { ok: false, message: `Refusing to delete "${className}": only Workbench cubes (SC.Workbench.Cube.*) can be deleted here.` };
  }
  const cubeName = shortCubeName(className);

  // 1. Drop fact tables/indices (ignore "cube doesn't exist" — we still delete the class).
  if (toBool(native.callValue('%DeepSee.Utils', '%CubeExists', cubeName))) {
    const killStatus = native.callValue('%DeepSee.Utils', '%KillCube', cubeName);
    const killed = native.decodeStatus(killStatus);
    if (!killed.ok) {
      return { ok: false, message: `Failed to drop cube data: ${killed.text}` };
    }
  }

  // 2. Delete the cube class definition. "d" = delete, "-d" silences display.
  const delStatus = native.callValue('%SYSTEM.OBJ', 'Delete', className, 'd-d');
  const deleted = native.decodeStatus(delStatus);
  if (!deleted.ok) {
    return { ok: false, message: `Cube data dropped, but deleting the class failed: ${deleted.text}` };
  }
  return { ok: true, message: `Cube "${cubeName}" deleted (data and definition removed).` };
}

/**
 * Assemble a cube's full structure (measures, dimensions→hierarchies→levels,
 * listings) from the read-only D2CLIENT Info REST API. The dimension tree is
 * reconstructed by parsing each filter's MDX spec `[dim].[hier].[level]` and
 * grouping. Any endpoint that errors (e.g. "no listings") degrades to an empty
 * array rather than failing the whole detail.
 */
export async function cubeStructure(
  deepsee: DeepSeeClient,
  cubeName: string,
  definition?: CubeDefinition | null,
): Promise<CubeStructure> {
  const [measuresRaw, filtersRaw, listingsRaw] = await Promise.all([
    deepsee.measures(cubeName).catch(() => []),
    deepsee.filters(cubeName).catch(() => []),
    deepsee.listings(cubeName).catch(() => []),
  ]);

  const measures: CubeMeasureInfo[] = measuresRaw
    .filter((m) => typeof m.name === 'string' && m.name.length)
    .map((m) => ({
      name: m.name!,
      caption: m.caption || undefined,
      type: m.type || undefined,
      hidden: m.hidden === 1 || m.hidden === true ? true : undefined,
      factName: m.factName || undefined,
    }));

  const listings: CubeListingInfo[] = listingsRaw
    .filter((l) => typeof l.name === 'string' && l.name.length)
    .map((l) => ({
      name: l.name!,
      fields: l.fields || undefined,
      order: l.order || undefined,
      type: l.type || undefined,
    }));

  const dimensions = dimensionsFromFilters(filtersRaw);
  if (definition) mergeSourceProperties(dimensions, definition);
  return { measures, dimensions, listings };
}

/**
 * Build a cube's display structure DIRECTLY from a (draft) CubeDefinition, for a
 * cube that isn't built in IRIS yet (draft/compiled) — the D2CLIENT Info API only
 * knows BUILT cubes, so `cubeStructure` returns empty for those. This lets the
 * detail view show the dimensions/measures the user already defined instead of a
 * misleading "No dimensions/measures defined".
 */
export function structureFromDefinition(def: CubeDefinition): CubeStructure {
  const measures: CubeMeasureInfo[] = (def.measures ?? [])
    .filter((m) => m.name?.trim())
    .map((m) => ({
      name: m.name,
      caption: m.displayName || undefined,
      type: m.type || undefined,
      hidden: m.hidden ? true : undefined,
      factName: m.factName || undefined,
    }));

  const dimensions: CubeDimensionInfo[] = (def.dimensions ?? [])
    .filter((d) => d.name?.trim())
    .map((d) => {
      const sharedTimeSource =
        d.type === 'time' || d.type === 'age'
          ? (d.sourceProperty ?? (d.hierarchies ?? []).flatMap((h) => h.levels ?? []).find((l) => l.sourceProperty)?.sourceProperty)
          : undefined;
      return {
        name: d.name,
        hierarchies: (d.hierarchies ?? [])
          .filter((h) => (h.levels ?? []).some((l) => l.name?.trim()))
          .map((h) => ({
            name: h.name?.trim() || 'H1',
            levels: (h.levels ?? [])
              .filter((l) => l.name?.trim())
              .map((l) => ({
                name: l.name,
                caption: l.displayName || undefined,
                type: l.timeFunction || undefined,
                spec: `[${d.name}].[${h.name?.trim() || 'H1'}].[${l.name}]`,
                sourceProperty: l.sourceProperty ?? sharedTimeSource ?? undefined,
                sourceExpression: l.sourceExpression ?? undefined,
              })),
          })),
      };
    });

  return { measures, dimensions, listings: [] };
}

/**
 * Merge each level's sourceProperty from the parsed class definition onto the
 * D2CLIENT-derived dimension tree (the Info API doesn't return it). Matches by
 * dimension name + level name; for a time dimension the source is the shared
 * date field the generator hoisted onto the <dimension>, so it applies to every
 * level. Best-effort — unmatched levels keep just their MDX/type.
 */
function mergeSourceProperties(dims: CubeDimensionInfo[], def: CubeDefinition): void {
  for (const dim of dims) {
    const defDim = (def.dimensions ?? []).find((d) => d.name === dim.name);
    if (!defDim) continue;
    dim.type = defDim.type;
    const defLevels = (defDim.hierarchies ?? []).flatMap((h) => h.levels ?? []);
    // A time dimension's date field is shared across its levels.
    const sharedTimeSource =
      defDim.type === 'time' || defDim.type === 'age'
        ? defLevels.find((l) => l.sourceProperty)?.sourceProperty
        : undefined;
    for (const hier of dim.hierarchies) {
      for (const level of hier.levels) {
        const defLevel = defLevels.find((l) => l.name === level.name);
        level.sourceProperty = defLevel?.sourceProperty ?? sharedTimeSource ?? level.sourceProperty;
        level.sourceExpression = defLevel?.sourceExpression ?? level.sourceExpression;
      }
    }
  }
}

/**
 * Turn the flat `/Info/Filters` list (one entry per level, MDX-encoded) into a
 * dimension → hierarchy → level tree, preserving first-seen order at each level.
 */
export function dimensionsFromFilters(filters: RawFilter[]): CubeDimensionInfo[] {
  const dims: CubeDimensionInfo[] = [];
  const dimIndex = new Map<string, CubeDimensionInfo>();
  const hierIndex = new Map<string, CubeHierarchyInfo>();

  for (const f of filters) {
    const parsed = parseMdxLevel(f.value);
    if (!parsed) continue;
    const { dim, hier, level } = parsed;

    let dimension = dimIndex.get(dim);
    if (!dimension) {
      dimension = { name: dim, hierarchies: [] };
      dimIndex.set(dim, dimension);
      dims.push(dimension);
    }

    const hierKey = `${dim}.${hier}`;
    let hierarchy = hierIndex.get(hierKey);
    if (!hierarchy) {
      hierarchy = { name: hier, levels: [] };
      hierIndex.set(hierKey, hierarchy);
      dimension.hierarchies.push(hierarchy);
    }

    hierarchy.levels.push({
      name: level,
      caption: f.caption || undefined,
      type: f.type || undefined,
      spec: f.value!,
    });
  }
  return dims;
}

/**
 * Parse an MDX level spec `[dim].[hier].[level]` into its three names. Returns
 * null for anything that isn't a 3-part bracketed spec (e.g. measures, members).
 */
export function parseMdxLevel(
  spec: string | undefined,
): { dim: string; hier: string; level: string } | null {
  if (!spec) return null;
  const parts = spec.match(/\[([^\]]*)\]/g);
  if (!parts || parts.length < 3) return null;
  const unwrap = (p: string) => p.slice(1, -1);
  return { dim: unwrap(parts[0]!), hier: unwrap(parts[1]!), level: unwrap(parts[2]!) };
}

// ---------- helpers ----------

/**
 * Derive the logical cube name from a class name. Our generator names classes
 * `SC.Core.Analytics.Cube.{X}`; the DeepSee cube name is the class's short name.
 * We keep it as-is (the generator appends "Cube" into the name when the caller
 * asks for it), so the cube name is simply the last dot-segment.
 */
function shortCubeName(className: string): string {
  const seg = className.split('.').pop() ?? className;
  return seg;
}

/** DependsOn may be a comma-list; the cube's source class is the first entry. */
function firstDependsOn(dependsOn?: string): string | undefined {
  if (!dependsOn) return undefined;
  const first = dependsOn.split(',')[0]?.trim();
  return first && first.length ? first : undefined;
}

function safeString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : String(v);
  return s.length ? s : undefined;
}

function safeFactCount(native: NativeClient, cubeName: string): number | undefined {
  try {
    const n = native.callValue('%DeepSee.Utils', '%GetCubeFactCount', cubeName);
    const num = typeof n === 'bigint' ? Number(n) : typeof n === 'number' ? n : Number(n);
    return Number.isFinite(num) ? num : undefined;
  } catch {
    return undefined;
  }
}

function toBool(v: unknown): boolean {
  return v === 1 || v === 1n || v === '1' || v === true;
}
