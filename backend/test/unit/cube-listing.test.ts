import { describe, it, expect } from 'vitest';
import { withDefaultListing, defaultListingName } from '../../src/cube/cube-listing.js';
import { generateCubeClass } from '../../src/cube/cube-generator.js';
import type { CubeDefinition } from '../../src/cube/cube-definition.model.js';

/** Non-reserved columns, by name. */
const cols = (...names: string[]) => names.map((name) => ({ name, reserved: false }));

const def: CubeDefinition = {
  cubeName: 'MfgOrderCube',
  sourceClass: 'SC.Data.MfgOrder',
  measures: [{ name: 'Qty', sourceProperty: 'quantity', factName: 'MxQty', aggregate: 'SUM', type: 'number', factNumber: 2 }],
};

describe('defaultListingName', () => {
  it('names the listing after the source class short name', () => {
    expect(defaultListingName('SC.Data.MfgOrder')).toBe('MfgOrderListing');
    expect(defaultListingName('SC.Data.ProductInventory')).toBe('ProductInventoryListing');
  });

  it('strips characters that are not valid in a listing name', () => {
    expect(defaultListingName('User.My_Class')).toBe('MyClassListing');
  });

  it('falls back to a generic name when nothing usable is left', () => {
    expect(defaultListingName('')).toBe('Listing');
  });
});

describe('withDefaultListing', () => {
  it('adds a table listing over every column, plain like SCO\'s own cubes, in the given order', () => {
    const out = withDefaultListing(def, cols('uid', 'productId', 'quantity'));
    expect(out.listings).toEqual([
      { name: 'MfgOrderListing', listingType: 'table', fieldList: 'uid,productId,quantity' },
    ]);
  });

  it('delimits only a reserved word (unquoted it is an SQL error)', () => {
    const out = withDefaultListing(def, [{ name: 'uid', reserved: false }, { name: 'group', reserved: true }]);
    expect(out.listings?.[0]?.fieldList).toBe('uid,"group"');
  });

  it('delimits a name that is not a plain identifier', () => {
    const out = withDefaultListing(def, cols('uid', 'my col', '1st', 'under_score'));
    expect(out.listings?.[0]?.fieldList).toBe('uid,"my col","1st",under_score');
  });

  it('does not mutate the input definition', () => {
    const before = structuredClone(def);
    withDefaultListing(def, cols('uid'));
    expect(def).toEqual(before);
  });

  it('escapes an embedded double quote in a column name', () => {
    const out = withDefaultListing(def, cols('we"ird'));
    expect(out.listings?.[0]?.fieldList).toBe('"we""ird"');
  });

  it('keeps listings the caller already supplied (never overrides them)', () => {
    const own = { ...def, listings: [{ name: 'Mine', fieldList: 'uid' }] };
    expect(withDefaultListing(own, cols('uid', 'quantity'))).toBe(own);
  });

  it('adds nothing when the source has no listable columns', () => {
    expect(withDefaultListing(def, [])).toBe(def);
  });

  it('skips blank and duplicate column names', () => {
    const out = withDefaultListing(def, cols('uid', ' ', 'uid', 'quantity'));
    expect(out.listings?.[0]?.fieldList).toBe('uid,quantity');
  });

  it('generates a <listing> element in the cube class', () => {
    const cls = generateCubeClass(withDefaultListing(def, cols('uid', 'quantity')));
    expect(cls).toContain('<listing name="MfgOrderListing" disabled="false" listingType="table" fieldList="uid,quantity">');
  });
});
