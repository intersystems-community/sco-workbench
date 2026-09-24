/**
 * What can this class actually be broken down BY?
 *
 * The hard case is a "soft" foreign key. An `SC.Data.*` class points at another
 * record with a plain `%String` holding that record's `uid` — e.g.
 * `SC.Data.ProductInventory.siteLocationId` — and because the property is NOT a
 * reference, DeepSee arrow traversal (`siteLocationId->name`) does not work. The only
 * way to break down by something on the RELATED record is a level `sourceExpression`.
 *
 * That makes a request like "a product inventory cube broken down by location"
 * under-specified in two ways at once:
 *   1. "location" is not a property of the base class at all — it is a related object;
 *   2. even once you know that, "by location" could mean its country, its state, its
 *      name, … and only SOME of those are reachable, because the reachable ones are
 *      whatever `SC.Core.Util.CubeUtil` already provides a getter for.
 *
 * So the answer is not a guess — it is a LIST of concrete, real options to put to the
 * user. This module derives that list from two facts read off the running instance
 * (the class's properties, and CubeUtil's methods) and pairs them up, producing
 * ready-to-paste `sourceExpression` strings. It is deliberately pure so the matching
 * rules are testable without IRIS.
 */

/** A property as `listProperties` reports it. */
export interface ClassProperty {
  name: string;
  type: string;
  isReference: boolean;
}

/** A method as `listMethods` reports it. */
export interface ClassMethod {
  name: string;
  isClassMethod: boolean;
  signature: string;
  returnType?: string;
  description?: string;
}

/** One ready-to-use level source, with the provenance the assistant needs to explain it. */
export interface HelperExpression {
  /** The CubeUtil method behind it. */
  method: string;
  /** What it returns, in the user's terms — the words after the entity in the method name (e.g. "Country"). */
  attribute: string;
  /** Paste-ready level sourceExpression. */
  expression: string;
  returnType?: string;
  description?: string;
}

/** A soft foreign key plus every breakdown reachable THROUGH it. */
export interface ForeignKeySuggestion {
  /** The FK property on the base class (e.g. "siteLocationId"). */
  property: string;
  /** The related entity it names (e.g. "location"). */
  entity: string;
  /** Breakdowns a CubeUtil getter can reach from this FK. Empty = nothing built in. */
  helpers: HelperExpression[];
}

export interface DimensionSuggestions {
  className: string;
  /** The helper class the expressions call. */
  helperClass: string;
  /** Scalar properties of the base class — a plain `sourceProperty` breakdown. */
  directProperties: ClassProperty[];
  /** Real object references, where arrow traversal (`prop->label`) IS available. */
  references: ClassProperty[];
  /** Soft foreign keys, each with the breakdowns reachable through it. */
  foreignKeys: ForeignKeySuggestion[];
  /** Getters keyed on the BASE row's own `uid` (e.g. getInventoryProductCategory(uid)). */
  baseRowHelpers: HelperExpression[];
  /**
   * Soft foreign keys with NO built-in getter. Breaking down by something on these
   * needs a hand-written guarded expression — the caller must say so rather than
   * silently offering the raw id.
   */
  unreachable: ForeignKeySuggestion[];
}

const HELPER_CLASS = 'SC.Core.Util.CubeUtil';

/** Split a PascalCase/camelCase identifier into lowercase words. */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Is this property a soft foreign key — a plain scalar named `<entity>Id`/`<entity>Uid`
 * that holds another record's uid? `uid` itself is the row's OWN key, not a foreign one.
 */
export function isSoftForeignKey(p: ClassProperty): boolean {
  if (p.isReference) return false;
  if (!/^%Library\.(String|Integer)$/.test(p.type) && !/^%(String|Integer)$/.test(p.type)) return false;
  const w = words(p.name);
  if (w.length < 2) return false; // bare "uid"/"id" is the row's own key
  return w[w.length - 1] === 'id' || w[w.length - 1] === 'uid';
}

/**
 * The related entity a soft FK names, as candidate tokens from most to least
 * specific: `siteLocationId` → ["sitelocation", "location"]. Both are offered because
 * a getter may be named for either the qualified or the bare entity.
 */
export function foreignKeyEntities(propertyName: string): string[] {
  const w = words(propertyName).slice(0, -1); // drop the trailing id/uid
  if (!w.length) return [];
  const full = w.join('');
  const last = w[w.length - 1]!;
  return full === last ? [full] : [full, last];
}

/**
 * Split a CubeUtil getter into the entity it reads FROM and the attribute it returns:
 * `getLocationCountry` → { entity: "location", attribute: "Country" }.
 *
 * The entity is taken as the FIRST word after `get` — SCO's getters are named
 * `get<Entity><Attribute>` — and the attribute is everything after it, kept in the
 * method's own casing so it can be shown to the user as-is. Returns null for a name
 * that isn't a getter or carries no attribute (e.g. `getDaysBefore` is a calculation,
 * not a lookup of some entity's field).
 */
export function parseHelper(methodName: string): { entity: string; attribute: string } | null {
  const m = /^get([A-Z][A-Za-z0-9]*)$/.exec(methodName);
  if (!m) return null;
  const rest = m[1]!;
  const w = words(rest);
  if (w.length < 2) return null; // e.g. getCarrierName is 2 words; getShipment alone is not a lookup
  const entity = w[0]!;
  // Re-slice the ORIGINAL string so the attribute keeps its casing ("ProductCategory").
  const attribute = rest.slice(entity.length);
  return { entity, attribute };
}

/** The single id-ish parameter of a helper, or null when it takes none or several. */
function soleIdParam(signature: string): string | null {
  const inside = /^\(([^)]*)\)/.exec(signature.trim());
  if (!inside) return null;
  const raw = inside[1]!.trim();
  if (!raw) return null;
  const params = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (params.length !== 1) return null;
  const name = params[0]!.split(/\s+/)[0]!;
  return /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : null;
}

/**
 * Abbreviations SCO uses in its getter names, so `getSOTotalQuantity` is understood to
 * read a SALES ORDER. Without this the abbreviation would either match nothing or —
 * worse — match anything that happens to start with the same two letters.
 */
const ENTITY_ALIASES: Record<string, string> = { so: 'salesorder' };

/** Shortest prefix overlap we trust. Two letters is not evidence: "so" is a prefix of
 *  "sourceLocation" as much as of "salesOrder", and a wrong pairing produces an
 *  expression that compiles and returns the wrong record's field. */
const MIN_PREFIX_MATCH = 4;

function expand(entity: string): string {
  return ENTITY_ALIASES[entity] ?? entity;
}

/** Do two entity words refer to the same thing? Exact match, or a prefix overlap long
 *  enough to be meaningful (see MIN_PREFIX_MATCH). */
function sameEntity(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= MIN_PREFIX_MATCH && longer.startsWith(shorter);
}

/** Does a helper's entity word refer to the same thing as one of a FK's entity tokens? */
function entityMatches(helperEntity: string, fkEntities: readonly string[]): boolean {
  const helper = expand(helperEntity);
  return fkEntities.some((fk) => sameEntity(expand(fk), helper));
}

/** Does a helper's entity word refer to the BASE class itself (so it takes %source.uid)? */
function matchesBaseClass(helperEntity: string, className: string): boolean {
  const helper = expand(helperEntity);
  return words(className.split('.').pop() ?? '').some((w) => sameEntity(expand(w), helper));
}

function toExpression(method: string, argument: string): string {
  return `##class(${HELPER_CLASS}).${method}(${argument})`;
}

/**
 * Pair a class's properties with the CubeUtil getters that can read through them.
 *
 * Only single-argument getters are paired: a getter taking several arguments (e.g.
 * `getInventoryStatusValue(inventory, productId, locationId)`) can't be wired up from
 * a property name alone, and offering it as if it could would produce an expression
 * that doesn't compile.
 */
export function suggestDimensionSources(
  className: string,
  properties: readonly ClassProperty[],
  helpers: readonly ClassMethod[],
): DimensionSuggestions {
  const softKeys = properties.filter(isSoftForeignKey);
  const softKeyNames = new Set(softKeys.map((p) => p.name));

  const candidates = helpers
    .filter((h) => h.isClassMethod)
    .map((h) => ({ h, parsed: parseHelper(h.name), param: soleIdParam(h.signature) }))
    .filter((c) => c.parsed !== null && c.param !== null && /(id|uid)$/i.test(c.param!));

  const foreignKeys: ForeignKeySuggestion[] = softKeys.map((fk) => {
    const entities = foreignKeyEntities(fk.name);
    const matched = candidates.filter((c) => entityMatches(c.parsed!.entity, entities));
    return {
      property: fk.name,
      entity: entities[entities.length - 1] ?? fk.name,
      helpers: matched.map(({ h, parsed }) => ({
        method: h.name,
        attribute: parsed!.attribute,
        expression: toExpression(h.name, `%source.${fk.name}`),
        returnType: h.returnType,
        description: h.description,
      })),
    };
  });

  // Getters keyed on the row's OWN uid: the parameter is a bare `uid`/`id` (no entity
  // prefix) AND the getter is named for this class (getInventory* on ProductInventory).
  const ownsUid = properties.some((p) => p.name === 'uid');
  const baseRowHelpers: HelperExpression[] = !ownsUid
    ? []
    : candidates
        .filter((c) => words(c.param!).length === 1 && matchesBaseClass(c.parsed!.entity, className))
        .map(({ h, parsed }) => ({
          method: h.name,
          attribute: parsed!.attribute,
          expression: toExpression(h.name, '%source.uid'),
          returnType: h.returnType,
          description: h.description,
        }));

  return {
    className,
    helperClass: HELPER_CLASS,
    directProperties: properties.filter((p) => !p.isReference && !softKeyNames.has(p.name)),
    references: properties.filter((p) => p.isReference),
    foreignKeys: foreignKeys.filter((f) => f.helpers.length > 0),
    baseRowHelpers,
    unreachable: foreignKeys.filter((f) => f.helpers.length === 0),
  };
}
