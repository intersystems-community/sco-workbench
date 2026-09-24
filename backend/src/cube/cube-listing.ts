/**
 * The default detail listing every Workbench cube gets: one table listing over
 * every column of the source class's base table, so drilling through a cell
 * shows the underlying records. Mirrors SCO's own cubes, e.g. ProductInventoryCube:
 *
 *   <listing name="InventoryListing" listingType="table"
 *            fieldList="uid,siteLocationId,productId,quantity,quantityUom,expirationDate">
 */
import type { CubeDefinition } from './cube-definition.model.js';
import type { ListingColumn } from '../iris/schema-ops.js';

/** "SC.Data.MfgOrder" → "MfgOrderListing". */
export function defaultListingName(sourceClass: string): string {
  const short = (sourceClass.split('.').pop() ?? '').replace(/[^A-Za-z0-9]/g, '');
  return `${short}Listing`;
}

/** A name IRIS SQL can select as-is (when it is also not a reserved word). */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `fieldList` is spliced into the listing's SQL SELECT. Columns are written
 * plain, like SCO's own listings; only a reserved word ("group", "date") or a
 * name that isn't a plain identifier is delimited, since unquoted it is an SQL
 * error. Delimiting doesn't change the listing's column headers.
 */
function selectable(column: ListingColumn): string {
  return column.reserved || !PLAIN_IDENTIFIER.test(column.name)
    ? `"${column.name.replace(/"/g, '""')}"`
    : column.name;
}

/**
 * Return `def` with a default table listing over `columns` (the base table's SQL
 * columns, in order). A definition that already has listings is returned
 * as-is, so a caller's own listings are never overridden; so is one with no
 * listable columns.
 */
export function withDefaultListing(def: CubeDefinition, columns: readonly ListingColumn[]): CubeDefinition {
  if (def.listings?.length) return def;
  const trimmed = columns.map((c) => ({ ...c, name: c.name.trim() })).filter((c) => c.name);
  const unique = trimmed.filter((c, i) => trimmed.findIndex((o) => o.name === c.name) === i);
  if (!unique.length) return def;
  return {
    ...def,
    listings: [
      { name: defaultListingName(def.sourceClass), listingType: 'table', fieldList: unique.map(selectable).join(',') },
    ],
  };
}
