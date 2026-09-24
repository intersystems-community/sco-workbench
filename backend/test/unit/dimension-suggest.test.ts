import { describe, it, expect } from 'vitest';
import {
  foreignKeyEntities,
  isSoftForeignKey,
  parseHelper,
  suggestDimensionSources,
  type ClassMethod,
  type ClassProperty,
} from '../../src/iris/dimension-suggest.js';

/**
 * "Create a product inventory cube broken down by location."
 *
 * `SC.Data.ProductInventory` has no `location` property — it has `siteLocationId`, a
 * plain %String holding a location's uid. Arrow traversal doesn't work on it, so the
 * only route is a level `sourceExpression`, and the reachable breakdowns are exactly
 * those `SC.Core.Util.CubeUtil` provides a getter for. These tests pin the pairing
 * rules, with a bias toward the ways a wrong pairing could slip through: an expression
 * built from a bad match still COMPILES and silently returns the wrong record's field.
 *
 * The property/method fixtures are trimmed copies of what the tools return from the
 * real instance (verified against it while writing this).
 */

const INVENTORY_PROPS: ClassProperty[] = [
  { name: 'uid', type: '%Library.String', isReference: false },
  { name: 'siteLocationId', type: '%Library.String', isReference: false },
  { name: 'productId', type: '%Library.String', isReference: false },
  { name: 'locationNumber', type: '%Library.String', isReference: false },
  { name: 'quantity', type: '%Library.Numeric', isReference: false },
  { name: 'status', type: '%Library.String', isReference: false },
  { name: 'expirationDate', type: '%Library.DateTime', isReference: false },
];

const CUBE_UTIL: ClassMethod[] = [
  { name: 'getLocationCountry', isClassMethod: true, signature: '(locUid As %String) As %Library.String', returnType: '%Library.String', description: 'Returns the country of a location' },
  { name: 'getLocationState', isClassMethod: true, signature: '(locUid As %String) As %Library.String', returnType: '%Library.String', description: 'Returns the state of a location' },
  { name: 'getProductName', isClassMethod: true, signature: '(prodUid As %String) As %Library.String', returnType: '%Library.String' },
  { name: 'getProductCategory', isClassMethod: true, signature: '(prodUid As %String) As %Library.String', returnType: '%Library.String' },
  { name: 'getCustomerName', isClassMethod: true, signature: '(customerUid As %String) As %Library.String', returnType: '%Library.String' },
  { name: 'getInventoryProductCategory', isClassMethod: true, signature: '(uid As %String) As %Library.String', returnType: '%Library.String' },
  { name: 'getInventoryQuantity', isClassMethod: true, signature: '(uid As %String) As %Library.Numeric', returnType: '%Library.Numeric' },
  // Several arguments: cannot be wired from a property name alone.
  { name: 'getInventoryStatusValue', isClassMethod: true, signature: '(inventory As %Numeric, productId As %String, locationId As String) As %Library.String', returnType: '%Library.String' },
  // Not an entity lookup at all — a date calculation.
  { name: 'getDaysBefore', isClassMethod: true, signature: '(targetDate As %DateTime) As %Library.Integer', returnType: '%Library.Integer' },
  { name: 'getSOTotalQuantity', isClassMethod: true, signature: '(soUid As %String) As %Library.Numeric', returnType: '%Library.Numeric' },
];

describe('isSoftForeignKey', () => {
  it('accepts a scalar <entity>Id / <entity>ID property', () => {
    expect(isSoftForeignKey({ name: 'siteLocationId', type: '%Library.String', isReference: false })).toBe(true);
    expect(isSoftForeignKey({ name: 'externalShipmentID', type: '%Library.String', isReference: false })).toBe(true);
    expect(isSoftForeignKey({ name: 'customerUid', type: '%Library.String', isReference: false })).toBe(true);
  });

  it('rejects the row’s OWN key — `uid` is not a foreign key', () => {
    expect(isSoftForeignKey({ name: 'uid', type: '%Library.String', isReference: false })).toBe(false);
    expect(isSoftForeignKey({ name: 'id', type: '%Library.String', isReference: false })).toBe(false);
  });

  it('rejects a real reference — arrow traversal works there, no expression needed', () => {
    expect(isSoftForeignKey({ name: 'customer', type: 'SC.Data.Customer', isReference: true })).toBe(false);
  });

  it('rejects a property that merely ENDS in something else, and non-scalar types', () => {
    expect(isSoftForeignKey({ name: 'locationNumber', type: '%Library.String', isReference: false })).toBe(false);
    expect(isSoftForeignKey({ name: 'validId', type: '%Library.DateTime', isReference: false })).toBe(false);
  });
});

describe('foreignKeyEntities', () => {
  it('offers the qualified entity AND the bare one, so either getter naming matches', () => {
    expect(foreignKeyEntities('siteLocationId')).toEqual(['sitelocation', 'location']);
    expect(foreignKeyEntities('shipToLocationId')).toEqual(['shiptolocation', 'location']);
  });

  it('collapses to one token when the name is already bare', () => {
    expect(foreignKeyEntities('productId')).toEqual(['product']);
  });
});

describe('parseHelper', () => {
  it('splits a getter into the entity it reads FROM and the attribute it returns', () => {
    expect(parseHelper('getLocationCountry')).toEqual({ entity: 'location', attribute: 'Country' });
    // The attribute keeps its own casing, so it can be shown to the user as-is.
    expect(parseHelper('getInventoryProductCategory')).toEqual({ entity: 'inventory', attribute: 'ProductCategory' });
    expect(parseHelper('getSOTotalQuantity')).toEqual({ entity: 'so', attribute: 'TotalQuantity' });
  });

  it('rejects a name that is not an entity lookup', () => {
    expect(parseHelper('getDaysBefore')).toEqual({ entity: 'days', attribute: 'Before' }); // still parses…
    expect(parseHelper('getShipment')).toBeNull(); // …but a single word is not a lookup
    expect(parseHelper('buildCube')).toBeNull();
  });
});

describe('suggestDimensionSources — "product inventory broken down by location"', () => {
  const s = suggestDimensionSources('SC.Data.ProductInventory', INVENTORY_PROPS, CUBE_UTIL);

  it('finds the location FK and offers ONLY the breakdowns a getter can reach', () => {
    const loc = s.foreignKeys.find((f) => f.property === 'siteLocationId');
    expect(loc?.entity).toBe('location');
    // Country and State exist; there is no getLocationName, so "by location NAME" is
    // NOT offered — that is the whole point: the reachable set is the utility's, not
    // an arbitrary column list.
    expect(loc?.helpers.map((h) => h.attribute).sort()).toEqual(['Country', 'State']);
    expect(loc?.helpers.map((h) => h.attribute)).not.toContain('Name');
  });

  it('produces a paste-ready expression that passes the FK, not the row', () => {
    const loc = s.foreignKeys.find((f) => f.property === 'siteLocationId');
    expect(loc?.helpers.find((h) => h.attribute === 'Country')?.expression).toBe(
      '##class(SC.Core.Util.CubeUtil).getLocationCountry(%source.siteLocationId)',
    );
  });

  it('offers the product FK’s own reachable set', () => {
    const prod = s.foreignKeys.find((f) => f.property === 'productId');
    expect(prod?.helpers.map((h) => h.attribute).sort()).toEqual(['Category', 'Name']);
  });

  it('does NOT offer another entity’s getter for this FK', () => {
    const loc = s.foreignKeys.find((f) => f.property === 'siteLocationId');
    expect(loc?.helpers.map((h) => h.method)).not.toContain('getCustomerName');
    expect(loc?.helpers.map((h) => h.method)).not.toContain('getProductName');
  });

  it('offers base-row getters keyed on the row’s own uid', () => {
    // getInventoryProductCategory takes the INVENTORY uid, not a product id — so the
    // argument has to be %source.uid or the build reads the wrong record.
    const cat = s.baseRowHelpers.find((h) => h.method === 'getInventoryProductCategory');
    expect(cat?.expression).toBe('##class(SC.Core.Util.CubeUtil).getInventoryProductCategory(%source.uid)');
    expect(s.baseRowHelpers.map((h) => h.method)).toContain('getInventoryQuantity');
  });

  it('skips a MULTI-argument getter — it cannot be wired from a property name', () => {
    const all = [...s.foreignKeys.flatMap((f) => f.helpers), ...s.baseRowHelpers].map((h) => h.method);
    expect(all).not.toContain('getInventoryStatusValue');
  });

  it('lists the scalar properties separately, excluding the foreign keys', () => {
    expect(s.directProperties.map((p) => p.name)).toContain('status');
    expect(s.directProperties.map((p) => p.name)).toContain('locationNumber');
    expect(s.directProperties.map((p) => p.name)).not.toContain('siteLocationId');
  });

  it('reports nothing unreachable here — both keys have getters', () => {
    expect(s.unreachable).toEqual([]);
  });
});

describe('suggestDimensionSources — guards against a plausible-but-wrong pairing', () => {
  it('does not pair the `getSO*` abbreviation with an unrelated `so…` entity', () => {
    // "so" is a prefix of "sourceLocation" as much as of "salesOrder". Pairing on two
    // letters would emit getSOTotalQuantity(%source.sourceLocationId) — which compiles
    // and returns nonsense.
    const props: ClassProperty[] = [{ name: 'sourceLocationId', type: '%Library.String', isReference: false }];
    const s = suggestDimensionSources('SC.Data.Thing', props, CUBE_UTIL);
    const fk = [...s.foreignKeys, ...s.unreachable].find((f) => f.property === 'sourceLocationId');
    expect(fk?.helpers.map((h) => h.method) ?? []).not.toContain('getSOTotalQuantity');
    // The location getters DO apply (the bare entity token still matches).
    expect(fk?.helpers.map((h) => h.attribute).sort()).toEqual(['Country', 'State']);
  });

  it('DOES pair `getSO*` with a real sales-order key (the documented abbreviation)', () => {
    const props: ClassProperty[] = [{ name: 'salesOrderId', type: '%Library.String', isReference: false }];
    const s = suggestDimensionSources('SC.Data.SalesShipment', props, CUBE_UTIL);
    const fk = s.foreignKeys.find((f) => f.property === 'salesOrderId');
    expect(fk?.helpers.map((h) => h.method)).toContain('getSOTotalQuantity');
  });

  it('reports a foreign key with NO getter as unreachable, not as a silent gap', () => {
    const props: ClassProperty[] = [{ name: 'trailerId', type: '%Library.String', isReference: false }];
    const s = suggestDimensionSources('SC.Data.SalesShipment', props, CUBE_UTIL);
    expect(s.foreignKeys).toEqual([]);
    expect(s.unreachable.map((f) => f.property)).toEqual(['trailerId']);
  });

  it('does not offer base-row getters to a class that has no uid', () => {
    const props: ClassProperty[] = [{ name: 'quantity', type: '%Library.Numeric', isReference: false }];
    expect(suggestDimensionSources('SC.Data.ProductInventory', props, CUBE_UTIL).baseRowHelpers).toEqual([]);
  });

  it('does not treat another class’s getters as base-row getters', () => {
    // getInventory* keyed on `uid` must not be offered when the cube is on SalesOrder.
    const props: ClassProperty[] = [{ name: 'uid', type: '%Library.String', isReference: false }];
    const s = suggestDimensionSources('SC.Data.SalesOrder', props, CUBE_UTIL);
    expect(s.baseRowHelpers.map((h) => h.method)).not.toContain('getInventoryQuantity');
  });

  it('keeps real references out of the FK list — they need no expression', () => {
    const props: ClassProperty[] = [{ name: 'customer', type: 'SC.Data.Customer', isReference: true }];
    const s = suggestDimensionSources('SC.Data.SalesOrder', props, CUBE_UTIL);
    expect(s.references.map((p) => p.name)).toEqual(['customer']);
    expect(s.foreignKeys).toEqual([]);
  });

  it('ignores instance methods — only ##class(...) ClassMethods are callable this way', () => {
    const helpers: ClassMethod[] = [
      { name: 'getLocationCountry', isClassMethod: false, signature: '(locUid As %String) As %Library.String' },
    ];
    const props: ClassProperty[] = [{ name: 'siteLocationId', type: '%Library.String', isReference: false }];
    const s = suggestDimensionSources('SC.Data.ProductInventory', props, helpers);
    expect(s.foreignKeys).toEqual([]);
    expect(s.unreachable.map((f) => f.property)).toEqual(['siteLocationId']);
  });
});
