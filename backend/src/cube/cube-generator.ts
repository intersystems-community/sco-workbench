// Ported from sco-ai-demo-builder create-cube skill (reference/cube-generator.service.ts).
// Generates the ObjectScript `.cls` for an IRIS BI cube from a CubeDefinition.
// The Angular @Injectable wrapper, browser file-download, and IRIS `.xml`
// export were intentionally dropped — the backend imports the `.cls` source
// directly via the Atelier REST API, so only the `.cls` text is needed.

import type {
  CubeDefinition,
  CubeDimension,
  HierarchyDef,
  LevelDef,
  PropertyDef,
  CubeMeasure,
  CubeRelationship,
  CubeExpression,
  CubeCalculatedMember,
  CubeNamedSet,
  CubeListing,
  CubeListingField,
} from './cube-definition.model.js';

/**
 * The package Workbench-created cubes live in. Deliberately DISTINCT from SCO's
 * built-in cubes (`SC.Core.Analytics.Cube.*`) so the Workbench can tell its own
 * editable cubes apart from the shipped ones, which it treats as read-only
 * (they use Architect-only features the Workbench can't safely round-trip).
 */
export const WORKBENCH_CUBE_PACKAGE = 'SC.Workbench.Cube';

/** The fully-qualified IRIS class name for a Workbench-created cube. */
export function cubeClassName(cubeName: string): string {
  return `${WORKBENCH_CUBE_PACKAGE}.${cubeName}`;
}

/** True if a cube CLASS is one the Workbench created (and may edit/delete). */
export function isWorkbenchCube(className: string): boolean {
  return className.startsWith(`${WORKBENCH_CUBE_PACKAGE}.`);
}

/**
 * A cube name is safe only if it is a valid ObjectScript class-name segment:
 * starts with a letter, then letters/digits/underscores. This keeps
 * `cubeClassName` (a raw concat) and `shortCubeName` (last dot-segment) in
 * agreement — a name with a dot or space would mis-derive one or the other and
 * make detail/delete target the wrong class.
 */
export function isValidCubeName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

/**
 * Validate structural invariants that IRIS requires but the type system can't
 * express. Returns a list of human-readable problems (empty = valid).
 *
 * LEVEL factNumbers must be unique and start at 2 (fact 1 = source record).
 * MEASURES are NOT validated for fact numbers: IRIS auto-assigns a measure's
 * fact slot from its sourceProperty, and several measures can share one source
 * (e.g. SUM+AVG+MAX of orderValue) — forcing distinct fact numbers there causes
 * "#5001: Multiple fact numbers defined for factID". So the generator omits
 * measure factNumbers/factNames and lets IRIS manage them.
 */
export function validateCubeDefinition(def: CubeDefinition): string[] {
  const problems: string[] = [];

  if (!def.cubeName?.trim()) {
    problems.push('cubeName is required.');
  } else if (!isValidCubeName(def.cubeName.trim())) {
    // The cube name becomes the last segment of an ObjectScript class name
    // (SC.Workbench.Cube.<name>) and a DeepSee cube identifier. A space, dot, or
    // other punctuation would mis-derive the class/short name (breaking
    // detail/delete targeting) or fail to compile. Reject it up front with a
    // clear message instead of generating a broken class.
    problems.push(
      `cubeName "${def.cubeName}" is invalid: use letters, digits, and underscores only (must start with a letter).`,
    );
  }
  if (!def.sourceClass?.trim()) problems.push('sourceClass is required.');

  const seen = new Map<number, string>();
  const check = (factNumber: number, where: string) => {
    if (factNumber < 2) {
      problems.push(`${where}: factNumber ${factNumber} is invalid (facts start at 2; fact 1 is the source record).`);
    }
    const prior = seen.get(factNumber);
    if (prior) {
      problems.push(`Duplicate factNumber ${factNumber} used by both ${prior} and ${where}.`);
    } else {
      seen.set(factNumber, where);
    }
  };

  for (const d of def.dimensions ?? []) {
    for (const h of d.hierarchies ?? []) {
      // A hierarchy that is being emitted (has a named level) must be named.
      const hierHasNamedLevel = (h.levels ?? []).some((l) => !l.disabled && l.name?.trim());
      if (!h.disabled && hierHasNamedLevel && !h.name?.trim()) {
        problems.push(`A hierarchy in dimension "${d.name || '(unnamed)'}" needs a name (e.g. "H1").`);
      }
      for (const l of h.levels ?? []) {
        check(l.factNumber, `level "${d.name}.${h.name ?? 'H1'}.${l.name}"`);
        // A named level MUST carry a source — a sourceProperty, a sourceExpression,
        // or (time/age dims) a timeFunction. A level with a name but no source
        // COMPILES but blows up at BUILD time with a raw <UNDEFINED> in
        // %BuildAllFacts (the fact column has nothing to read). Catch it here.
        if (!l.disabled && l.name?.trim()) {
          const hasSource =
            !!l.sourceProperty?.trim() || !!l.sourceExpression?.trim() || !!l.timeFunction?.trim();
          if (!hasSource) {
            problems.push(
              `Level "${d.name}.${h.name ?? 'H1'}.${l.name}" needs a source: choose a source property, ` +
                `enter a source expression, or (for a time dimension) pick a time function.`,
            );
          }
        }
      }
    }
    // A dimension with no enabled hierarchy/level makes IRIS fail cube-class
    // compilation deep in %DeepSee.CubeDefinition (a bare "#5001: Dimension must
    // have at least one enabled hierarchy" or a raw <SUBSCRIPT> in %UpdateFactsList).
    // Catch it here with an actionable message so the user isn't shown the
    // untranslatable IRIS generator error. Match the runtime invariant: at least
    // one non-disabled hierarchy that has at least one non-disabled level with a
    // name (an empty/unnamed level is dropped by the payload builder / generator).
    if (!d.disabled) {
      const hasEnabledLevel = (d.hierarchies ?? []).some(
        (h) => !h.disabled && (h.levels ?? []).some((l) => !l.disabled && l.name?.trim()),
      );
      if (!hasEnabledLevel) {
        problems.push(
          `Dimension "${d.name || '(unnamed)'}" must have at least one hierarchy with a named level. ` +
            `Add a level (with a source property, expression, or time function) or remove the dimension.`,
        );
      }
    }
  }

  // A measure's source is NOT required: a measure with no sourceProperty /
  // sourceExpression is a COUNT of the source rows (the generator coerces its
  // aggregate to COUNT — see buildMeasure), which needs no source column. So we
  // deliberately do not require one here.
  for (const r of def.relationships ?? []) check(r.factNumber, `relationship "${r.name}"`);

  return problems;
}

/** Generate the cube `.cls` source. Throws if the definition is invalid. */
export function generateCubeClass(def: CubeDefinition): string {
  const problems = validateCubeDefinition(def);
  if (problems.length) {
    throw new Error(`Invalid cube definition:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const className = cubeClassName(def.cubeName);
  const lines: string[] = [];

  if (def.description) lines.push(`/// ${def.description}`);
  lines.push(
    `Class ${className} Extends %DeepSee.CubeDefinition [ DependsOn = ${def.sourceClass}, ProcedureBlock ]`,
  );
  lines.push(`{`);
  lines.push(``);
  if (def.description) lines.push(`/// ${def.description}`);
  lines.push(`XData Cube [ XMLNamespace = "http://www.intersystems.com/deepsee" ]`);
  lines.push(`{`);
  lines.push(buildCubeElement(def));
  lines.push(`}`);
  lines.push(``);
  lines.push(`Parameter DOMAIN;`);
  lines.push(``);
  lines.push(`}`);

  return lines.join('\n');
}

function buildCubeElement(def: CubeDefinition): string {
  const attrs = buildCubeAttrs(def);
  const children = buildCubeChildren(def);
  if (!children) return `<cube ${attrs}>\n</cube>`;
  return `<cube ${attrs}>\n${children}</cube>`;
}

function buildCubeAttrs(def: CubeDefinition): string {
  const cubeName = def.cubeName;
  const attrs: [string, string][] = [
    ['xmlns', 'http://www.intersystems.com/deepsee'],
    ['name', cubeName],
    ['displayName', def.displayName ?? cubeName],
  ];
  if (def.description != null) attrs.push(['description', def.description]);
  attrs.push(['disabled', String(def.disabled ?? false)]);
  attrs.push(['abstract', String(def.abstract ?? false)]);
  attrs.push(['sourceClass', def.sourceClass]);
  // namedFactNums defaults to FALSE: IRIS then auto-assigns fact storage, which
  // correctly supports multiple measures over one source property (SUM/AVG/MAX
  // of the same field) — with named fact numbers on, those would need to share
  // a hand-assigned fact number and mismatches throw #5001. Levels keep their
  // explicit factNumbers regardless; this only affects measure fact storage.
  attrs.push(['namedFactNums', String(def.namedFactNums ?? false)]);
  attrs.push(['countMeasureName', def.countMeasureName ?? '%COUNT']);
  attrs.push(['bucketSize', String(def.bucketSize ?? 8)]);
  attrs.push(['bitmapChunkInMemory', String(def.bitmapChunkInMemory ?? false)]);
  if (def.defaultListing != null) attrs.push(['defaultListing', def.defaultListing]);
  attrs.push(['precompute', String(def.precompute ?? 0)]);
  attrs.push(['disableListingGroups', String(def.disableListingGroups ?? false)]);
  attrs.push(['enableSqlRestrict', String(def.enableSqlRestrict ?? false)]);
  return attrs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
}

function buildCubeChildren(def: CubeDefinition): string {
  const parts: string[] = [];
  for (const d of def.dimensions ?? []) parts.push(buildDimension(d));
  for (const m of def.measures ?? []) parts.push(buildMeasure(m));
  for (const r of def.relationships ?? []) parts.push(buildRelationship(r));
  for (const e of def.expressions ?? []) parts.push(buildExpression(e));
  for (const c of def.calculatedMembers ?? []) parts.push(buildCalculatedMember(c));
  for (const n of def.namedSets ?? []) parts.push(buildNamedSet(n));
  for (const l of def.listings ?? []) parts.push(buildListing(l));
  for (const lf of def.listingFields ?? []) parts.push(buildListingField(lf));
  return parts.length ? parts.join('\n') + '\n' : '';
}

function buildDimension(d: CubeDimension): string {
  const isTimeLike = d.type === 'time' || d.type === 'age';
  // IRIS requires a time/age DIMENSION to carry the sourceProperty (the date/
  // number field); its levels then extract parts via timeFunction. The form
  // captures sourceProperty on the levels, so hoist it here when the dimension
  // itself doesn't already have one — otherwise IRIS errors with
  // "#5001: Time dimension must have a sourceProperty or sourceExpression".
  const hoisted =
    d.sourceProperty ??
    (isTimeLike
      ? d.hierarchies?.flatMap((h) => h.levels ?? []).find((l) => l.sourceProperty)?.sourceProperty
      : undefined);

  const attrs: [string, string][] = [['name', d.name]];
  if (d.displayName != null) attrs.push(['displayName', d.displayName]);
  if (d.description != null) attrs.push(['description', d.description]);
  attrs.push(['disabled', String(d.disabled ?? false)]);
  attrs.push(['hasAll', String(d.hasAll ?? false)]);
  attrs.push(['allCaption', d.allCaption ?? `All ${d.name}`]);
  attrs.push(['allDisplayName', d.allDisplayName ?? d.name]);
  if (hoisted != null) attrs.push(['sourceProperty', hoisted]);
  attrs.push(['type', d.type]);
  if (d.calendar != null) attrs.push(['calendar', d.calendar]);
  if (d.iKnowType != null) attrs.push(['iKnowType', d.iKnowType]);
  attrs.push(['hidden', String(d.hidden ?? false)]);
  attrs.push(['showHierarchies', d.showHierarchies ?? 'default']);

  // For time/age dimensions the level's source comes from the dimension, so a
  // level must NOT repeat sourceProperty — it carries only its timeFunction.
  const hierarchies = (d.hierarchies ?? [])
    .map((h) => buildHierarchy(isTimeLike ? stripLevelSources(h) : h))
    .join('\n');
  return `  <dimension ${attrsStr(attrs)}>\n${hierarchies}\n  </dimension>`;
}

/** Drop sourceProperty/sourceExpression from a time/age hierarchy's levels. */
function stripLevelSources(h: HierarchyDef): HierarchyDef {
  return {
    ...h,
    levels: (h.levels ?? []).map((l) => {
      const { sourceProperty, sourceExpression, ...rest } = l;
      void sourceProperty;
      void sourceExpression;
      return rest as LevelDef;
    }),
  };
}

function buildHierarchy(h: HierarchyDef): string {
  const attrs: [string, string][] = [['name', h.name ?? 'H1']];
  if (h.displayName != null) attrs.push(['displayName', h.displayName]);
  if (h.description != null) attrs.push(['description', h.description]);
  attrs.push(['disabled', String(h.disabled ?? false)]);
  attrs.push(['hidden', String(h.hidden ?? false)]);

  const inner: string[] = [];
  if (h.additionalDescription != null) {
    inner.push(`      <additionalDescription>${escapeXml(h.additionalDescription)}</additionalDescription>`);
  }
  for (const l of h.levels ?? []) inner.push(buildLevel(l));

  return `    <hierarchy ${attrsStr(attrs)}>\n${inner.join('\n')}\n    </hierarchy>`;
}

function buildLevel(l: LevelDef): string {
  const attrs: [string, string][] = [['name', l.name]];
  if (l.displayName != null) attrs.push(['displayName', l.displayName]);
  if (l.description != null) attrs.push(['description', l.description]);
  attrs.push(['disabled', String(l.disabled ?? false)]);
  if (l.sourceProperty != null) attrs.push(['sourceProperty', l.sourceProperty]);
  if (l.sourceExpression != null) attrs.push(['sourceExpression', l.sourceExpression]);
  if (l.timeFunction != null) attrs.push(['timeFunction', l.timeFunction]);
  attrs.push(['list', String(l.list ?? false)]);
  if (l.nullReplacement != null) attrs.push(['nullReplacement', l.nullReplacement]);
  if (l.rangeExpression != null) attrs.push(['rangeExpression', l.rangeExpression]);
  attrs.push(['useDisplayValue', String(l.useDisplayValue ?? true)]);
  attrs.push(['useAsFilter', String(l.useAsFilter ?? true)]);
  attrs.push(['hidden', String(l.hidden ?? false)]);
  attrs.push(['factNumber', String(l.factNumber)]);
  if (l.dependsOn != null) attrs.push(['dependsOn', l.dependsOn]);

  const inner: string[] = [];
  if (l.additionalDescription != null) {
    inner.push(`        <additionalDescription>${escapeXml(l.additionalDescription)}</additionalDescription>`);
  }
  for (const p of l.properties ?? []) inner.push(buildProperty(p));
  if (!inner.length) return `      <level ${attrsStr(attrs)}>\n      </level>`;
  return `      <level ${attrsStr(attrs)}>\n${inner.join('\n')}\n      </level>`;
}

function buildProperty(p: PropertyDef): string {
  const attrs: [string, string][] = [['name', p.name]];
  if (p.displayName != null) attrs.push(['displayName', p.displayName]);
  if (p.description != null) attrs.push(['description', p.description]);
  attrs.push(['disabled', String(p.disabled ?? false)]);
  if (p.sourceProperty != null) attrs.push(['sourceProperty', p.sourceProperty]);
  if (p.factName != null) attrs.push(['factName', p.factName]);
  attrs.push(['hidden', String(p.hidden ?? false)]);
  if (p.sort != null) attrs.push(['sort', p.sort]);
  if (p.isName != null) attrs.push(['isName', String(p.isName)]);
  if (p.isDescription != null) attrs.push(['isDescription', String(p.isDescription)]);
  if (p.isReference != null) attrs.push(['isReference', String(p.isReference)]);
  if (p.useDisplayValue != null) attrs.push(['useDisplayValue', String(p.useDisplayValue)]);

  if (p.additionalDescription != null) {
    return `        <property ${attrsStr(attrs)}>\n          <additionalDescription>${escapeXml(p.additionalDescription)}</additionalDescription>\n        </property>`;
  }
  return `        <property ${attrsStr(attrs)}>\n        </property>`;
}

function buildMeasure(m: CubeMeasure): string {
  // A measure with NO source (neither a sourceProperty nor a sourceExpression)
  // is a COUNT of the source rows — there's no column to SUM/AVG/etc. Coerce the
  // aggregate to COUNT so a sourceless measure is valid (SUM-of-nothing would
  // otherwise build into an empty/meaningless fact). A sourced measure keeps its
  // chosen aggregate.
  const hasSource = !!m.sourceProperty?.trim() || !!m.sourceExpression?.trim();
  const aggregate = hasSource ? m.aggregate : 'COUNT';

  const attrs: [string, string][] = [['name', m.name]];
  if (m.displayName != null) attrs.push(['displayName', m.displayName]);
  if (m.description != null) attrs.push(['description', m.description]);
  attrs.push(['disabled', String(m.disabled ?? false)]);
  if (m.sourceProperty != null) attrs.push(['sourceProperty', m.sourceProperty]);
  attrs.push(['aggregate', aggregate]);
  attrs.push(['type', m.type]);
  attrs.push(['hidden', String(m.hidden ?? false)]);
  attrs.push(['searchable', String(m.searchable ?? false)]);
  if (m.listingFilterValue != null) attrs.push(['listingFilterValue', m.listingFilterValue]);
  if (m.listingFilterOperator != null) attrs.push(['listingFilterOperator', m.listingFilterOperator]);
  // NOTE: factName + factNumber are intentionally NOT emitted for measures.
  // IRIS auto-assigns the fact slot from the sourceProperty, and multiple
  // measures may share one source (SUM/AVG/MAX of the same field). Emitting an
  // explicit factName/factNumber there triggers "#5001: Multiple fact numbers
  // defined for factID". Levels still carry explicit unique factNumbers.

  if (m.additionalDescription != null) {
    return `  <measure ${attrsStr(attrs)}>\n    <additionalDescription>${escapeXml(m.additionalDescription)}</additionalDescription>\n  </measure>`;
  }
  return `  <measure ${attrsStr(attrs)}>\n  </measure>`;
}

function buildRelationship(r: CubeRelationship): string {
  const attrs: [string, string][] = [['name', r.name]];
  if (r.displayName != null) attrs.push(['displayName', r.displayName]);
  if (r.description != null) attrs.push(['description', r.description]);
  attrs.push(['disabled', String(r.disabled ?? true)]);
  if (r.sourceProperty != null) attrs.push(['sourceProperty', r.sourceProperty]);
  if (r.factName != null) attrs.push(['factName', r.factName]);
  attrs.push(['relatedCube', r.relatedCube]);
  attrs.push(['inverse', r.inverse]);
  attrs.push(['cardinality', r.cardinality]);
  if (r.nullReplacement != null) attrs.push(['nullReplacement', r.nullReplacement]);
  attrs.push(['factNumber', String(r.factNumber)]);

  if (r.additionalDescription != null) {
    return `  <relationship ${attrsStr(attrs)}>\n    <additionalDescription>${escapeXml(r.additionalDescription)}</additionalDescription>\n  </relationship>`;
  }
  return `  <relationship ${attrsStr(attrs)}>\n  </relationship>`;
}

function buildExpression(e: CubeExpression): string {
  const attrs: [string, string][] = [['name', e.name]];
  if (e.description != null) attrs.push(['description', e.description]);
  attrs.push(['disabled', String(e.disabled ?? false)]);
  attrs.push(['sourceExpression', e.sourceExpression]);

  if (e.additionalDescription != null) {
    return `  <expression ${attrsStr(attrs)}>\n    <additionalDescription>${escapeXml(e.additionalDescription)}</additionalDescription>\n  </expression>`;
  }
  return `  <expression ${attrsStr(attrs)}>\n  </expression>`;
}

function buildCalculatedMember(c: CubeCalculatedMember): string {
  const attrs: [string, string][] = [['name', c.name]];
  if (c.displayName != null) attrs.push(['displayName', c.displayName]);
  if (c.description != null) attrs.push(['description', c.description]);
  attrs.push(['disabled', String(c.disabled ?? false)]);
  attrs.push(['dimension', c.dimension]);
  attrs.push(['valueExpression', c.valueExpression]);
  if (c.formatString != null) attrs.push(['formatString', c.formatString]);
  attrs.push(['hidden', String(c.hidden ?? false)]);
  if (c.listingFilter != null) attrs.push(['listingFilter', c.listingFilter]);

  if (c.additionalDescription != null) {
    return `  <calculatedMember ${attrsStr(attrs)}>\n    <additionalDescription>${escapeXml(c.additionalDescription)}</additionalDescription>\n  </calculatedMember>`;
  }
  return `  <calculatedMember ${attrsStr(attrs)}>\n  </calculatedMember>`;
}

function buildNamedSet(n: CubeNamedSet): string {
  const attrs: [string, string][] = [['name', n.name]];
  if (n.displayName != null) attrs.push(['displayName', n.displayName]);
  if (n.description != null) attrs.push(['description', n.description]);
  attrs.push(['disabled', String(n.disabled ?? false)]);
  attrs.push(['setExpression', n.setExpression]);

  if (n.additionalDescription != null) {
    return `  <namedSet ${attrsStr(attrs)}>\n    <additionalDescription>${escapeXml(n.additionalDescription)}</additionalDescription>\n  </namedSet>`;
  }
  return `  <namedSet ${attrsStr(attrs)}>\n  </namedSet>`;
}

function buildListing(l: CubeListing): string {
  const attrs: [string, string][] = [['name', l.name]];
  if (l.displayName != null) attrs.push(['displayName', l.displayName]);
  if (l.description != null) attrs.push(['description', l.description]);
  attrs.push(['disabled', String(l.disabled ?? false)]);
  attrs.push(['listingType', l.listingType ?? 'table']);
  if (l.fieldList != null) attrs.push(['fieldList', l.fieldList]);
  if (l.orderBy != null) attrs.push(['orderBy', l.orderBy]);
  if (l.sql != null) attrs.push(['sql', l.sql]);
  if (l.resource != null) attrs.push(['resource', l.resource]);
  if (l.selectMode != null) attrs.push(['selectMode', String(l.selectMode)]);

  if (l.additionalDescription != null) {
    return `  <listing ${attrsStr(attrs)}>\n    <additionalDescription>${escapeXml(l.additionalDescription)}</additionalDescription>\n  </listing>`;
  }
  return `  <listing ${attrsStr(attrs)}>\n  </listing>`;
}

function buildListingField(lf: CubeListingField): string {
  const attrs: [string, string][] = [['name', lf.name]];
  if (lf.displayName != null) attrs.push(['displayName', lf.displayName]);
  if (lf.description != null) attrs.push(['description', lf.description]);
  attrs.push(['disabled', String(lf.disabled ?? false)]);
  attrs.push(['fieldExpression', lf.fieldExpression]);
  if (lf.resource != null) attrs.push(['resource', lf.resource]);
  return `  <listingField ${attrsStr(attrs)}>\n  </listingField>`;
}

function attrsStr(attrs: [string, string][]): string {
  return attrs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
