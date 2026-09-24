import {
  SC_DATA_RESOURCES, OBJECT_TO_RESOURCE, resourceForObject, customResourcePath,
} from './sc-data-resources';

/**
 * Captured live from GET /api/scmodel/v1/objects on 2026-08-14 (33 objects).
 * A committed fixture, not a live call: the guard must run with no instance.
 */
const SCMODEL_OBJECT_NAMES = [
  'BOM', 'Carrier', 'Customer', 'DemandPlan', 'InventoryThreshold', 'Issue',
  'LeadtimeVariant', 'Location', 'MfgOrder', 'Milestone', 'Product',
  'ProductInventory', 'ProductSupplier', 'ProductionCapacity', 'PurchaseOrder',
  'PurchaseOrderLine', 'RouteLeg', 'SCException', 'SLA', 'SalesOrder',
  'SalesOrderLine', 'SalesShipment', 'SalesShipmentLine', 'ServiceSLA',
  'ShipmentMilestone', 'ShipmentStop', 'ShipmentTracking', 'ShippingCost',
  'Supplier', 'SupplyPlan', 'SupplyShipment', 'SupplyShipmentLine',
  'TrackingService',
];

describe('sc-data resources', () => {
  it('exposes every resource path in lowercase, because scdata paths are case-sensitive', () => {
    const offenders = Object.entries(SC_DATA_RESOURCES)
      .filter(([, path]) => path !== path.toLowerCase())
      .map(([key, path]) => `${key}: '${path}'`);
    expect(offenders).toEqual([]);
  });

  it('maps every scmodel object name to a resource', () => {
    const unmapped = SCMODEL_OBJECT_NAMES.filter((name) => resourceForObject(name) === null);
    expect(unmapped).toEqual([]);
  });

  it('has no phantom consolidatedinventories entry', () => {
    expect(Object.values(SC_DATA_RESOURCES)).not.toContain('consolidatedinventories');
  });

  it('maps ProductionCapacity to the working lowercase path', () => {
    expect(resourceForObject('ProductionCapacity')).toBe('productioncapacities');
  });

  it('returns null for an unknown built-in object name rather than undefined', () => {
    expect(resourceForObject('NoSuchObject')).toBeNull();
  });

  it('derives the scdata path for a custom object as lowercase(name + "s")', () => {
    expect(resourceForObject('HelloWorld', true)).toBe('helloworlds');
    expect(customResourcePath('HelloWorld')).toBe('helloworlds');
  });

  it('still returns null for an unmapped object that is not custom', () => {
    expect(resourceForObject('HelloWorld', false)).toBeNull();
  });

  it('lets the static map win over derivation even for a custom-flagged name', () => {
    // A built-in irregular path must never be overridden by the naive rule.
    expect(resourceForObject('BOM', true)).toBe('billofmaterials');
  });

  it('maps names no rule could derive', () => {
    expect(resourceForObject('BOM')).toBe('billofmaterials');
    expect(resourceForObject('MfgOrder')).toBe('manufacturingorders');
    expect(resourceForObject('ProductInventory')).toBe('productinventories');
  });

  it('covers 33 object names', () => {
    expect(Object.keys(OBJECT_TO_RESOURCE)).toHaveLength(33);
  });
});
