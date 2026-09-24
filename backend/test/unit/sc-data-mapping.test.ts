// backend/test/unit/sc-data-mapping.test.ts
//
// Which SC_Data table each sample-data CSV goes into, and the ORDER the files load in.
// Both are load-bearing: the first is the only thing standing between someone's CSV and a
// real product table, and the second is what keeps SC_Data's FOREIGN KEYs satisfiable (a
// SalesOrder cannot reference a Customer that is not in yet).
//
// Neither is a list any more. A file finds its table by NAME among the tables the
// namespace actually has, and the order comes from the FK graph IRIS reports — so what
// these tests guard is the RESOLUTION RULES (what counts as a name match, and what must
// resolve to nothing rather than to a guess) and the sort's behaviour on the awkward
// graphs: a parent the set does not bring, a self-reference, a cycle, a file for no table.
import { describe, it, expect } from 'vitest';
import {
  KEY_HEADERS,
  SC_DATA_SCHEMA,
  UID_COLUMN,
  orderSampleCsvFiles,
  resolveScDataTable,
} from '../../src/util/sc-data-mapping.js';

/** The files the shipped Test1 set actually contains. */
const SHIPPED_FILES = [
  'carriers.csv',
  'customers.csv',
  'demandPlan.csv',
  'inventoryThresholds.csv',
  'locations.csv',
  'productInventory.csv',
  'products.csv',
  'purchaseOrderLines.csv',
  'purchaseOrders.csv',
  'salesOrderLines.csv',
  'salesOrders.csv',
  'salesShipmentLines.csv',
  'salesShipments.csv',
  'suppliers.csv',
  'supplyShipmentLines.csv',
  'supplyShipments.csv',
];

/**
 * The tables `SC_Data` has, from the live instance (2026-09-08) — all 33, because a file
 * may be named after any of them. The last fourteen are the ones no shipped file covers,
 * and they are the interesting half: a set that adds a file for one of them must load
 * without a change to this repo.
 */
const INSTALLED = [
  'BOM',
  'Carrier',
  'Customer',
  'DemandPlan',
  'InventoryThreshold',
  'Location',
  'Product',
  'ProductInventory',
  'ProductSupplier',
  'PurchaseOrder',
  'PurchaseOrderLine',
  'SLA',
  'SalesOrder',
  'SalesOrderLine',
  'SalesShipment',
  'SalesShipmentLine',
  'Supplier',
  'SupplyShipment',
  'SupplyShipmentLine',
  'Issue',
  'LeadtimeVariant',
  'MfgOrder',
  'Milestone',
  'ProductionCapacity',
  'RouteLeg',
  'SCException',
  'ServiceSLA',
  'ShipmentMilestone',
  'ShipmentStop',
  'ShipmentTracking',
  'ShippingCost',
  'SupplyPlan',
  'TrackingService',
];

describe('the two names the load is pinned to', () => {
  it('targets the product schema and its primary key', () => {
    expect(SC_DATA_SCHEMA).toBe('SC_Data');
    expect(UID_COLUMN).toBe('uid');
  });

  it('prefers UID over ID, because a file with both means two different things by them', () => {
    // The key column is the one place a header is not simply the column's own name: the
    // shipped sets spell it `ID`, an SC_Data export spells it `uid` and carries the
    // INTERNAL ROW ID in `ID`. Reading `ID` there would put an integer in the primary key
    // and orphan every foreign key in the rest of the set.
    expect(KEY_HEADERS).toEqual(['UID', 'ID']);
  });
});

describe('resolveScDataTable', () => {
  it('finds the table each shipped file is named after', () => {
    // Every file in the shipped set, against the real installed list: this is the
    // guarantee the whole loader now rests on, so it is asserted rather than assumed.
    expect(SHIPPED_FILES.map((file) => resolveScDataTable(file, INSTALLED))).toEqual([
      'Carrier',
      'Customer',
      'DemandPlan',
      'InventoryThreshold',
      'Location',
      'ProductInventory',
      'Product',
      'PurchaseOrderLine',
      'PurchaseOrder',
      'SalesOrderLine',
      'SalesOrder',
      'SalesShipmentLine',
      'SalesShipment',
      'Supplier',
      'SupplyShipmentLine',
      'SupplyShipment',
    ]);
  });

  it('finds a table no shipped file covers, singular or plural', () => {
    // The whole point of resolving by name: adding a file for an installed table must not
    // mean editing this repo.
    expect(resolveScDataTable('mfgOrders.csv', INSTALLED)).toBe('MfgOrder');
    expect(resolveScDataTable('MfgOrder.csv', INSTALLED)).toBe('MfgOrder');
    expect(resolveScDataTable('Issues.csv', INSTALLED)).toBe('Issue');
    expect(resolveScDataTable('trackingServices.csv', INSTALLED)).toBe('TrackingService');
    expect(resolveScDataTable('shipmentStops.csv', INSTALLED)).toBe('ShipmentStop');
    expect(resolveScDataTable('supplyPlan.csv', INSTALLED)).toBe('SupplyPlan');
  });

  it('ignores case, separators and the path around the name', () => {
    for (const name of [
      'MFG_ORDERS.CSV',
      'mfg-orders.csv',
      'Mfg Orders.csv',
      '/tmp/sets/Test9/mfgorders.csv',
    ]) {
      expect(resolveScDataTable(name, INSTALLED), name).toBe('MfgOrder');
    }
  });

  it('handles the plurals a file name actually uses', () => {
    const tables = ['Delivery', 'Batch', 'Address', 'Box', 'Analysis'];
    expect(resolveScDataTable('deliveries.csv', tables)).toBe('Delivery');
    expect(resolveScDataTable('batches.csv', tables)).toBe('Batch');
    expect(resolveScDataTable('addresses.csv', tables)).toBe('Address');
    expect(resolveScDataTable('boxes.csv', tables)).toBe('Box');
    // Not a linguistic singularizer, and not pretending to be: "analyses" is not derived.
    expect(resolveScDataTable('analyses.csv', tables)).toBeUndefined();
  });

  it('does not mangle a name that only LOOKS plural', () => {
    // `sla`/`status` end in s without being plurals; taking the s off would miss the
    // table entirely (or, worse, hit a different one).
    expect(resolveScDataTable('sla.csv', INSTALLED)).toBe('SLA');
    expect(resolveScDataTable('status.csv', ['Status'])).toBe('Status');
  });

  it('resolves an AMBIGUOUS name to nothing rather than guessing a table', () => {
    // Two installed tables the file name fits equally. Loading the user's rows into the
    // wrong table is far worse than reporting the file as skipped.
    const both = ['ProductSupplier', 'Product_Supplier'];
    expect(resolveScDataTable('productSupplier.csv', both)).toBeUndefined();
    expect(resolveScDataTable('company.csv', ['Company', 'Companies'])).toBe('Company');
    expect(resolveScDataTable('companys.csv', ['Company', 'Companies'])).toBeUndefined();
  });

  it('prefers an EXACT name over a singularized one', () => {
    // Both rules match here; the file said `Milestones`, and a table of exactly that name
    // is not a plural to be undone.
    expect(resolveScDataTable('milestones.csv', ['Milestone', 'Milestones'])).toBe('Milestones');
  });

  it('is undefined for a file no installed table takes', () => {
    // The user's rule: report it and move on, so this has to be distinguishable from a
    // resolved table rather than fall back to something.
    for (const name of ['notes.csv', 'readme.csv', '.csv', '', 'products.csv.bak']) {
      expect(resolveScDataTable(name, INSTALLED), name).toBeUndefined();
    }
    // …including when the schema is empty, i.e. SCO is not installed in this namespace.
    expect(resolveScDataTable('locations.csv', [])).toBeUndefined();
  });
});

describe('orderSampleCsvFiles, with nothing to order by', () => {
  it('returns the files exactly as given', () => {
    // No FK graph means no basis for an order. The caller's own order (alphabetical, from
    // `listSampleDataCsvFiles`) is better than an invented one.
    const input = ['salesOrderLines.csv', 'salesOrders.csv', 'customers.csv', 'locations.csv'];
    expect(orderSampleCsvFiles(input)).toEqual(input);
  });

  it('leaves the caller\'s array alone, and copes with an empty set', () => {
    const input = ['SALESORDERS.CSV', 'Locations.csv'];
    expect(orderSampleCsvFiles(input)).not.toBe(input);
    expect(input).toEqual(['SALESORDERS.CSV', 'Locations.csv']);
    expect(orderSampleCsvFiles([])).toEqual([]);
  });
});

describe('orderSampleCsvFiles, ordered by the live FOREIGN KEY graph', () => {
  /** The live SC_Data graph, abridged to the tables these tests use (child → parents). */
  const PARENTS: Record<string, string[]> = {
    location: [],
    carrier: [],
    product: [],
    bom: ['product'],
    customer: ['location'],
    supplier: ['location'],
    productsupplier: ['product', 'supplier'],
    inventorythreshold: ['location', 'product'],
    productinventory: ['product', 'location'],
    demandplan: ['product', 'location'],
    salesorder: ['customer', 'location'],
    salesorderline: ['salesorder', 'product'],
    salesshipment: ['carrier', 'customer', 'location', 'salesshipment'],
    salesshipmentline: ['salesshipment', 'salesorderline', 'salesorder', 'product'],
    purchaseorder: ['supplier', 'location'],
    purchaseorderline: ['purchaseorder', 'product'],
    supplyshipment: ['carrier', 'supplier', 'location', 'supplyshipment'],
    supplyshipmentline: ['supplyshipment', 'purchaseorderline', 'purchaseorder', 'product'],
    mfgorder: ['product', 'salesorder', 'location'],
    supplyplan: ['location', 'product'],
    routeleg: ['shipmentstop'],
    shipmentstop: [],
  };
  /** As IRIS answers it: lowercased names, and nothing for a table with no keys. */
  const parentsOf = (table: string) => PARENTS[table.toLowerCase()] ?? [];
  const tableOf = (file: string) => resolveScDataTable(file, INSTALLED);
  const options = { tableOf, parentsOf };

  it('orders the whole shipped set with every parent before its children', () => {
    // Handed the set BACKWARDS, so nothing can pass on the input order alone.
    const ordered = orderSampleCsvFiles([...SHIPPED_FILES].reverse(), options);
    const at = (file: string) => ordered.indexOf(file);
    expect(ordered).toHaveLength(SHIPPED_FILES.length);
    expect(at('locations.csv')).toBeLessThan(at('customers.csv'));
    expect(at('locations.csv')).toBeLessThan(at('suppliers.csv'));
    expect(at('products.csv')).toBeLessThan(at('productInventory.csv'));
    expect(at('products.csv')).toBeLessThan(at('inventoryThresholds.csv'));
    expect(at('customers.csv')).toBeLessThan(at('salesOrders.csv'));
    expect(at('suppliers.csv')).toBeLessThan(at('purchaseOrders.csv'));
    expect(at('salesOrders.csv')).toBeLessThan(at('salesOrderLines.csv'));
    expect(at('salesOrderLines.csv')).toBeLessThan(at('salesShipmentLines.csv'));
    expect(at('carriers.csv')).toBeLessThan(at('salesShipments.csv'));
    expect(at('salesShipments.csv')).toBeLessThan(at('salesShipmentLines.csv'));
    expect(at('purchaseOrders.csv')).toBeLessThan(at('purchaseOrderLines.csv'));
    expect(at('purchaseOrderLines.csv')).toBeLessThan(at('supplyShipmentLines.csv'));
    expect(at('supplyShipments.csv')).toBeLessThan(at('supplyShipmentLines.csv'));
  });

  it('puts a file no shipped set ever had after the parents its own keys name', () => {
    // SC_Data.MfgOrder references Product, SalesOrder and Location. Handed to the loader
    // FIRST, it still loads last — nothing here was told about mfgOrders.csv.
    const ordered = orderSampleCsvFiles(
      ['mfgOrders.csv', 'salesOrders.csv', 'products.csv', 'locations.csv', 'customers.csv'],
      options,
    );
    expect(ordered.indexOf('mfgOrders.csv')).toBe(ordered.length - 1);
    // products.csv and locations.csv are both ready from the start, so between those two
    // the caller's order stands — products was listed first.
    expect(ordered).toEqual([
      'products.csv',
      'locations.csv',
      'customers.csv',
      'salesOrders.csv',
      'mfgOrders.csv',
    ]);
  });

  it('keeps the order the caller gave between files with nothing between them', () => {
    // Neither references the other, so there is nothing to sort by and the caller's order
    // stands — which is what makes a load report reproducible run to run.
    expect(orderSampleCsvFiles(['products.csv', 'carriers.csv'], options)).toEqual([
      'products.csv',
      'carriers.csv',
    ]);
    expect(orderSampleCsvFiles(['carriers.csv', 'products.csv'], options)).toEqual([
      'carriers.csv',
      'products.csv',
    ]);
  });

  it('orders two files against each other on their keys, not on their names', () => {
    // routeLegs.csv/shipmentStops.csv, either way round: the child must not go first and
    // orphan every row in it, whichever way the caller listed them.
    expect(orderSampleCsvFiles(['routeLegs.csv', 'shipmentStops.csv'], options)).toEqual([
      'shipmentStops.csv',
      'routeLegs.csv',
    ]);
    expect(orderSampleCsvFiles(['shipmentStops.csv', 'routeLegs.csv'], options)).toEqual([
      'shipmentStops.csv',
      'routeLegs.csv',
    ]);
  });

  it('does not wait for a parent the set does not bring', () => {
    // routeLegs.csv alone cannot wait for shipmentStops.csv — it is not coming. The rows
    // that need it are reported as orphans by the load; the file is not held back.
    expect(orderSampleCsvFiles(['routeLegs.csv'], options)).toEqual(['routeLegs.csv']);
    expect(orderSampleCsvFiles(['mfgOrders.csv', 'products.csv'], options)).toEqual([
      'products.csv',
      'mfgOrders.csv',
    ]);
  });

  it('does not wait for ITSELF on a self-referencing table', () => {
    // SC_Data.SalesShipment references SalesShipment (a parent shipment). One file's own
    // rows satisfy that, so treating it as a dependency would deadlock the whole set.
    const ordered = orderSampleCsvFiles(['salesShipments.csv', 'carriers.csv'], options);
    expect(ordered).toEqual(['carriers.csv', 'salesShipments.csv']);
  });

  it('keeps a file whose table cannot be resolved at all', () => {
    // It is reported as skipped by the route; a silent disappearance would hide a typo in
    // a file name from whoever assembled the set.
    expect(orderSampleCsvFiles(['notes.csv', 'locations.csv'], options)).toEqual([
      'notes.csv',
      'locations.csv',
    ]);
    // It waits for nothing and holds nothing back, so it lands wherever the caller put
    // it among the files that are ready — here ahead of the pair that has an order.
    expect(orderSampleCsvFiles(['customers.csv', 'notes.csv', 'locations.csv'], options)).toEqual([
      'notes.csv',
      'locations.csv',
      'customers.csv',
    ]);
  });

  it('falls back to the given order on a CYCLE instead of dropping the files', () => {
    // SC_Data has none beyond self-references, but a future model might; losing the
    // user's files over it would be the worse failure.
    const cycle = (table: string) =>
      table.toLowerCase() === 'issue' ? ['milestone'] : ['issue'];
    expect(
      orderSampleCsvFiles(['milestones.csv', 'issues.csv'], { tableOf, parentsOf: cycle }),
    ).toEqual(['milestones.csv', 'issues.csv']);
  });
});
