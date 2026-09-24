/**
 * scdata resource paths and the objectName → resource mapping.
 *
 * Two things live here that used to live apart: the resource strings (from
 * `sc-data.service.ts`) and the objectName → resource lookup (private to
 * `resources.ts`). The mapping is load-bearing and not derivable — scmodel's
 * payload carries no resource name, and no rule produces one
 * (`BOM`→`billofmaterials`, `MfgOrder`→`manufacturingorders`). It is shared by
 * the Data Model view and the Dashboard, so it is here and it has a test.
 *
 * Two defects were found by probing all 35 former entries live on 2026-08-14
 * and are fixed below:
 *  - `productionCapacities` → `productioncapacities`. scdata paths are
 *    case-sensitive, so the mixed-case value 404'd, and the Data Model view's
 *    record count for `ProductionCapacity` had always failed silently.
 *  - `consolidatedinventories` deleted. No such endpoint exists and no scmodel
 *    object refers to it.
 *
 * `predictedinventories` is live but unmapped — legitimate, so the completeness
 * test asserts one direction only.
 */
export const SC_DATA_RESOURCES = {
  billOfMaterials:            'billofmaterials',
  carriers:                   'carriers',
  customers:                  'customers',
  demandPlans:                'demandplans',
  inventoryThresholds:        'inventorythresholds',
  issues:                     'issues',
  leadTimeVariants:           'leadtimevariants',
  locations:                  'locations',
  manufacturingOrders:        'manufacturingorders',
  milestones:                 'milestones',
  predictedInventories:       'predictedinventories',
  productInventories:         'productinventories',
  productionCapacities:       'productioncapacities',
  products:                   'products',
  productSuppliers:           'productsuppliers',
  purchaseOrderLines:         'purchaseorderlines',
  purchaseOrders:             'purchaseorders',
  routeLegs:                  'routelegs',
  salesOrderLines:            'salesorderlines',
  salesOrders:                'salesorders',
  salesShipmentLines:         'salesshipmentlines',
  salesShipments:             'salesshipments',
  scExceptions:               'scexceptions',
  serviceSLAs:                'serviceslas',
  shipmentMilestones:         'shipmentmilestones',
  shipmentStops:              'shipmentstops',
  shipmentTrackings:          'shipmenttrackings',
  shippingCosts:              'shippingcosts',
  slas:                       'slas',
  suppliers:                  'suppliers',
  supplyPlans:                'supplyplans',
  supplyShipmentLines:        'supplyshipmentlines',
  supplyShipments:            'supplyshipments',
  trackingServices:           'trackingservices',
} as const;

export type ScDataResource = typeof SC_DATA_RESOURCES[keyof typeof SC_DATA_RESOURCES];

/** scmodel `objectName` → scdata resource path. Relocated from `resources.ts:79-113`. */
export const OBJECT_TO_RESOURCE: Readonly<Record<string, ScDataResource>> = {
  BOM:                  SC_DATA_RESOURCES.billOfMaterials,
  Carrier:              SC_DATA_RESOURCES.carriers,
  Customer:             SC_DATA_RESOURCES.customers,
  DemandPlan:           SC_DATA_RESOURCES.demandPlans,
  InventoryThreshold:   SC_DATA_RESOURCES.inventoryThresholds,
  Issue:                SC_DATA_RESOURCES.issues,
  LeadtimeVariant:      SC_DATA_RESOURCES.leadTimeVariants,
  Location:             SC_DATA_RESOURCES.locations,
  MfgOrder:             SC_DATA_RESOURCES.manufacturingOrders,
  Milestone:            SC_DATA_RESOURCES.milestones,
  Product:              SC_DATA_RESOURCES.products,
  ProductInventory:     SC_DATA_RESOURCES.productInventories,
  ProductSupplier:      SC_DATA_RESOURCES.productSuppliers,
  ProductionCapacity:   SC_DATA_RESOURCES.productionCapacities,
  PurchaseOrder:        SC_DATA_RESOURCES.purchaseOrders,
  PurchaseOrderLine:    SC_DATA_RESOURCES.purchaseOrderLines,
  RouteLeg:             SC_DATA_RESOURCES.routeLegs,
  SCException:          SC_DATA_RESOURCES.scExceptions,
  SLA:                  SC_DATA_RESOURCES.slas,
  SalesOrder:           SC_DATA_RESOURCES.salesOrders,
  SalesOrderLine:       SC_DATA_RESOURCES.salesOrderLines,
  SalesShipment:        SC_DATA_RESOURCES.salesShipments,
  SalesShipmentLine:    SC_DATA_RESOURCES.salesShipmentLines,
  ServiceSLA:           SC_DATA_RESOURCES.serviceSLAs,
  ShipmentMilestone:    SC_DATA_RESOURCES.shipmentMilestones,
  ShipmentStop:         SC_DATA_RESOURCES.shipmentStops,
  ShipmentTracking:     SC_DATA_RESOURCES.shipmentTrackings,
  ShippingCost:         SC_DATA_RESOURCES.shippingCosts,
  Supplier:             SC_DATA_RESOURCES.suppliers,
  SupplyPlan:           SC_DATA_RESOURCES.supplyPlans,
  SupplyShipment:       SC_DATA_RESOURCES.supplyShipments,
  SupplyShipmentLine:   SC_DATA_RESOURCES.supplyShipmentLines,
  TrackingService:      SC_DATA_RESOURCES.trackingServices,
};

/**
 * The scdata resource path a custom object exposes. The backend
 * (`SC.Core.API.Data.CustomObjectApiImpl.RefreshCustomDataObjectApi`) generates
 * the path as `lowercase(objectName + "s")` with no real pluralization, so this
 * mirrors that rule exactly — `HelloWorld` → `helloworlds`.
 */
export function customResourcePath(objectName: string): string {
  return `${objectName}s`.toLowerCase();
}

/**
 * The resource path for an scmodel object, or null when the object is not
 * browsable via scdata.
 *
 * Built-in objects resolve through the static map, because their paths are
 * irregular and not derivable (`BOM`→`billofmaterials`). Custom objects carry
 * no map entry but are browsable: when `isCustom` is set the path is derived by
 * the same rule the backend used to generate it.
 */
export function resourceForObject(objectName: string, isCustom = false): ScDataResource | string | null {
  const mapped = OBJECT_TO_RESOURCE[objectName];
  if (mapped) return mapped;
  return isCustom ? customResourcePath(objectName) : null;
}
