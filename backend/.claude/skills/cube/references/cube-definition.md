# Cube definition reference

Shared reference for what an SCO analytics cube is, what each field means, and example
definitions. Used by both the agent and guided cube workflows (see
`references/agent-workflow.md` and `references/guided-workflow.md`).

## What a cube is
An SCO analytics cube (a `%DeepSee.CubeDefinition` subclass, e.g.
`SC.Core.Analytics.Cube.SalesOrderCube`) turns a source class (a table of
records, e.g. `SC.Data.SalesOrder`) into something you can slice and aggregate.
One source row = one fact.

Field by field:
- **name / cubeName** — the cube name (e.g. `SalesOrderCube`); becomes the class
  segment and the MDX cube name. Workbench-created cubes are deployed under
  `SC.Workbench.Cube.{cubeName}`; SCO's built-in cubes live under
  `SC.Core.Analytics.Cube.*` and are read-only.
- **sourceClass** — the fully-qualified persistent class whose records the cube
  reads (dotted ObjectScript form, e.g. `SC.Data.SalesOrder`).
- **Measures** — the numbers you aggregate. Each has a **sourceProperty** (or a
  **sourceExpression**), an **aggregate** (SUM / COUNT / AVG / MIN / MAX), and a
  **type** (integer / number / boolean / string / date). `%COUNT` (the row count)
  is always available automatically — you never declare it.
- **Dimensions** — the ways you break numbers down: by region, status, or time.
  Each dimension has a **type** (`data` or `time`), one or more **hierarchies**,
  and each hierarchy has **levels**.
  - A **data** level maps to a `sourceProperty` (e.g. `salesRegion`) or a
    `sourceExpression` (ObjectScript, e.g. a computed status). A `rangeExpression`
    can bucket a numeric expression into labels (e.g. `(,24]:OnTime;(24,):Late;`).
  - A **time** level is extracted from ONE date property via a **timeFunction**
    (Year / QuarterYear / MonthYear / WeekYear / DayMonthYear / DayWeek /
    HourNumber). Several time levels can share one date property.

    **Default a time dimension to THREE levels — Year, Month, Day — in one hierarchy.**
    A time dimension exists so the user can drill down through time; a single Year level
    can only ever answer year-scale questions, and adding the others later means editing
    and rebuilding the cube. So unless the user asks for something else, build:

    ```xml
    <dimension name="orderPlacedDate" sourceProperty="orderPlacedDate" type="time">
      <hierarchy name="H1">
        <level name="Year"  timeFunction="Year"/>
        <level name="Month" timeFunction="MonthYear"/>
        <level name="Day"   timeFunction="DayMonthYear"/>
      </hierarchy>
    </dimension>
    ```

    Note the timeFunctions: `MonthYear` and `DayMonthYear` (NOT `Month`/`Day`, which do
    not exist) — each is scoped within its year, which is what makes the drill-down
    Year → Month → Day work. Add `QuarterYear` between Year and Month when the user
    thinks in quarters, and use a coarser set only if they say so (e.g. Year + Month for
    monthly reporting). Every level still needs its own unique `factNumber`.

## Example definitions
Excerpts from real SCO cube classes (the `<cube>` XData is what the Architect /
compiler reads). They come from a reference/testing environment; a given instance
may have different cubes, so treat these as illustrative patterns of how measures,
data dimensions, and time dimensions fit together — not a promise of what's
deployed. Excerpts are abbreviated to the parts worth teaching; the real classes
have more dimensions.

### Example 1 — `SC.Core.Analytics.Cube.SalesOrderCube` (source `SC.Data.SalesOrder`)
```xml
<cube name="SalesOrderCube" sourceClass="SC.Data.SalesOrder" countMeasureName="%COUNT">
  <!-- data dimension off a plain property -->
  <dimension name="salesRegion" type="data">
    <hierarchy name="H1">
      <level name="salesRegion" sourceProperty="salesRegion" nullReplacement="Unknown"/>
    </hierarchy>
  </dimension>
  <!-- data dimension computed by an expression + rangeExpression bucketing -->
  <dimension name="latestDeliveryVsRequested" type="data">
    <hierarchy name="H1">
      <level name="status"
             sourceExpression="##class(SC.Core.Util.CubeUtil).getSOLateDeliveryHours(%source.uid, %source.requestedDeliveryDate)"
             rangeExpression="(,24]:OnTime;(24,):Late;" nullReplacement="Unknown"/>
    </hierarchy>
  </dimension>
  <!-- time dimension: several levels off ONE date property via timeFunction -->
  <dimension name="orderPlacedDate" sourceProperty="orderPlacedDate" type="time">
    <hierarchy name="H1">
      <level name="Year"    timeFunction="Year"/>
      <level name="Quarter" timeFunction="QuarterYear"/>
      <level name="Month"   timeFunction="MonthYear"/>
    </hierarchy>
  </dimension>
  <!-- three measures, all off the orderValue property, different aggregates -->
  <measure name="totalOrderValue"   sourceProperty="orderValue" aggregate="SUM" type="number"/>
  <measure name="averageOrderValue" sourceProperty="orderValue" aggregate="AVG" type="number"/>
  <measure name="maxOrderValue"     sourceProperty="orderValue" aggregate="MAX" type="number"/>
</cube>
```
Shows the three building blocks: a **data dimension** straight off a property
(`salesRegion`), a **computed data dimension** where a `sourceExpression` returns
a number that `rangeExpression` buckets into OnTime/Late labels, and a **time
dimension** with Year/Quarter/Month levels all derived from the single
`orderPlacedDate` property via `timeFunction`. Note three measures share one
source property (`orderValue`) with different aggregates — SUM, AVG, MAX — and
`%COUNT` is implicit (the `countMeasureName`), never declared.

### Example 2 — `SC.Core.Analytics.Cube.ProductInventoryCube` (source `SC.Data.ProductInventory`)
```xml
<cube name="ProductInventoryCube" sourceClass="SC.Data.ProductInventory" countMeasureName="%COUNT">
  <!-- expiration status bucketed from "days before expiry" -->
  <dimension name="expirationStatus" type="data">
    <hierarchy name="H1">
      <level name="status"
             sourceExpression="##class(SC.Core.Util.CubeUtil).getDaysBefore(%source.expirationDate)"
             rangeExpression="(,0]:Expired;(0,7]:Expiring;(7,):Good;" nullReplacement="Undefined"/>
    </hierarchy>
  </dimension>
  <!-- a time dimension on the expiration date -->
  <dimension name="expirationDateHierarchy" sourceProperty="expirationDate" type="time">
    <hierarchy name="H1">
      <level name="year"  timeFunction="Year"/>
      <level name="month" timeFunction="MonthYear"/>
    </hierarchy>
  </dimension>
  <measure name="totalQuantity"     sourceProperty="quantity"        aggregate="SUM" type="number"/>
  <measure name="totalValue"        sourceProperty="inventoryValue"  aggregate="SUM" type="number"/>
  <!-- a measure computed from an expression rather than a single property -->
  <measure name="availableQuantity" sourceExpression="%source.quantity-%source.quantityReserved"
           aggregate="SUM" type="number"/>
</cube>
```
The `expirationStatus` dimension is a good teaching case: a helper returns
days-until-expiry and `rangeExpression` turns the number into
Expired/Expiring/Good — that's exactly what KPIs then filter on (e.g.
`[expirationStatus].[H1].[status].&[Expired]`). Also note `availableQuantity` is a
**measure built from a `sourceExpression`** (`quantity - quantityReserved`)
instead of a plain property.

### Example 3 — `SC.Core.Analytics.Cube.SalesShipmentCube` (source `SC.Data.SalesShipment`)
```xml
<cube name="SalesShipmentCube" sourceClass="SC.Data.SalesShipment" countMeasureName="%COUNT">
  <!-- lookup-by-id dimension via a util expression -->
  <dimension name="carrier" type="data">
    <hierarchy name="H1">
      <level name="name"
             sourceExpression="##class(SC.Core.Util.CubeUtil).getCarrierName(%source.carrierId)"
             nullReplacement="Unknown"/>
    </hierarchy>
  </dimension>
  <!-- delivery lateness bucketed into Early / OnTime / Late -->
  <dimension name="estimatedVsRequestedDelivery" sourceProperty="estimatedTimeOfArrival" type="data">
    <hierarchy name="H1">
      <level name="status"
             sourceExpression="##class(SC.Core.Util.CubeUtil).getHoursLate(%source.requestedTimeOfArrival,%source.estimatedTimeOfArrival)"
             rangeExpression="(,-8):Early;[-8,8]:OnTime;(8,):Late;" nullReplacement="Unknown"/>
    </hierarchy>
  </dimension>
  <!-- multi-level location hierarchy: country then state -->
  <dimension name="shipToLocation" type="data">
    <hierarchy name="H1">
      <level name="country" sourceExpression="##class(SC.Core.Util.CubeUtil).getLocationCountry(%source.destinationLocationId)"/>
      <level name="state"   sourceExpression="##class(SC.Core.Util.CubeUtil).getLocationState(%source.destinationLocationId)"/>
    </hierarchy>
  </dimension>
  <!-- time dimension on the actual ship date -->
  <dimension name="actualShipDate" sourceProperty="actualShipDate" type="time">
    <hierarchy name="H1">
      <level name="year"    timeFunction="Year"/>
      <level name="quarter" timeFunction="QuarterYear"/>
      <level name="month"   timeFunction="MonthYear"/>
    </hierarchy>
  </dimension>
</cube>
```
This cube is mostly dimensions and relies on `%COUNT` (no custom measures shown) —
it's built for counting shipments sliced many ways. Note the `shipToLocation`
hierarchy has **two levels (country → state)** in one hierarchy, and several "vs"
dimensions reuse the same Early/OnTime/Late `rangeExpression` pattern on different
date pairs.

## Editability note
Built-in SCO cubes (`SC.Core.Analytics.Cube.*`) are **read-only** in the Workbench
— they're managed in the BI Architect. Only cubes created in the Workbench
(class prefix `SC.Workbench.Cube.*`) are editable here.
