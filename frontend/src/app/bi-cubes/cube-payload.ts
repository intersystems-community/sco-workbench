/**
 * Maps the bi-cubes UI form model to the backend cube `definition` payload that
 * POST/PUT /api/cubes expects (which mirrors the backend CubeDefinition model).
 *
 * The critical backend rule: every level AND measure carries a `factNumber`
 * that must be UNIQUE across the whole cube and START AT 2 (fact 1 is the source
 * record). The UI form doesn't track fact numbers, so we assign them here in a
 * single sweep. Measures also require a `factName`; we derive a safe one from
 * the measure name when the form doesn't supply it.
 */

interface FormLevel {
  name: string;
  displayName?: string;
  sourceProperty?: string;
  sourceExpression?: string;
  /** Which source the level uses — property XOR expression. */
  srcKind?: 'property' | 'expression';
  timeFunction?: string;
  sort?: string;
  hidden?: boolean;
}
interface FormHierarchy {
  name: string;
  displayName?: string;
  levels: FormLevel[];
}
interface FormDimension {
  name: string;
  displayName?: string;
  type: string;
  hasAll?: boolean;
  hidden?: boolean;
  hierarchies: FormHierarchy[];
}
interface FormMeasure {
  name: string;
  displayName?: string;
  sourceProperty?: string;
  sourceExpression?: string;
  /** Which source the measure uses — property XOR expression. */
  srcKind?: 'property' | 'expression';
  aggregate: string;
  type: string;
  hidden?: boolean;
  searchable?: boolean;
}
export interface CubeFormLike {
  name: string;
  displayName?: string;
  description?: string;
  sourceClass: string;
  dimensions: FormDimension[];
  measures: FormMeasure[];
}

/**
 * Emit exactly one source for a level — property XOR expression — based on the
 * form's `srcKind` (falling back to whichever value is present). A level with
 * both set is invalid in IRIS, so we never emit both.
 */
function levelSource(l: FormLevel): { sourceProperty?: string } | { sourceExpression?: string } {
  const prop = l.sourceProperty?.trim();
  const expr = l.sourceExpression?.trim();
  const kind = l.srcKind ?? (expr ? 'expression' : 'property');
  if (kind === 'expression') return expr ? { sourceExpression: expr } : {};
  return prop ? { sourceProperty: prop } : {};
}

/**
 * Emit exactly one source for a measure — property XOR expression — based on the
 * form's `srcKind` (falling back to whichever value is present). A measure with
 * both set is invalid in IRIS, so we never emit both. A measure may also have
 * NEITHER (e.g. an aggregate over the record with no scalar source), which is
 * allowed — this returns `{}` then.
 */
function measureSource(m: FormMeasure): { sourceProperty?: string } | { sourceExpression?: string } {
  const prop = m.sourceProperty?.trim();
  const expr = m.sourceExpression?.trim();
  const kind = m.srcKind ?? (expr ? 'expression' : 'property');
  if (kind === 'expression') return expr ? { sourceExpression: expr } : {};
  return prop ? { sourceProperty: prop } : {};
}

/** A single, sanitized factName from a measure name (alphanumeric, unique-ish). */
function toFactName(measureName: string): string {
  const cleaned = measureName.replace(/[^A-Za-z0-9]/g, '');
  return cleaned || 'Measure';
}

/**
 * Build the backend cube definition from the UI form, assigning unique
 * factNumbers (starting at 2) across every level and measure in document order.
 * `%COUNT` measures (blank/`%`-prefixed) are dropped — the cube always has an
 * implicit %COUNT and re-declaring it collides.
 */
export function formToCubeDefinition(f: CubeFormLike): Record<string, unknown> {
  let fact = 2;

  const dimensions = (f.dimensions ?? [])
    .filter((d) => d.name?.trim())
    .map((d) => ({
      name: d.name.trim(),
      type: (d.type || 'data') as string,
      ...(d.displayName?.trim() ? { displayName: d.displayName.trim() } : {}),
      ...(d.hasAll !== undefined ? { hasAll: d.hasAll } : {}),
      ...(d.hidden ? { hidden: d.hidden } : {}),
      hierarchies: (d.hierarchies ?? [])
        .filter((h) => (h.levels ?? []).some((l) => l.name?.trim()))
        .map((h) => ({
          name: h.name?.trim() || 'H1',
          ...(h.displayName?.trim() ? { displayName: h.displayName.trim() } : {}),
          levels: (h.levels ?? [])
            .filter((l) => l.name?.trim())
            .map((l) => ({
              name: l.name.trim(),
              factNumber: fact++,
              ...(l.displayName?.trim() ? { displayName: l.displayName.trim() } : {}),
              // Emit ONLY the chosen source — property XOR expression — so the
              // generator/IRIS never sees both (which is invalid).
              ...levelSource(l),
              ...(l.timeFunction?.trim() ? { timeFunction: l.timeFunction.trim() } : {}),
              ...(l.sort?.trim() ? { sort: l.sort.trim() } : {}),
              ...(l.hidden ? { hidden: l.hidden } : {}),
            })),
        })),
    }));

  const measures = (f.measures ?? [])
    .filter((m) => m.name?.trim() && !m.name.trim().startsWith('%'))
    .map((m) => ({
      name: m.name.trim(),
      factName: toFactName(m.name.trim()),
      aggregate: (m.aggregate || 'SUM') as string,
      type: (m.type || 'number') as string,
      factNumber: fact++,
      ...(m.displayName?.trim() ? { displayName: m.displayName.trim() } : {}),
      // Emit ONLY the chosen source — property XOR expression — so the
      // generator/IRIS never sees both (which is invalid).
      ...measureSource(m),
      ...(m.hidden ? { hidden: m.hidden } : {}),
      ...(m.searchable ? { searchable: m.searchable } : {}),
    }));

  return {
    cubeName: f.name.trim(),
    sourceClass: f.sourceClass.trim(),
    ...(f.displayName?.trim() ? { displayName: f.displayName.trim() } : {}),
    ...(f.description?.trim() ? { description: f.description.trim() } : {}),
    dimensions,
    measures,
  };
}
