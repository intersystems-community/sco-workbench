/**
 * ObjectScript source for the temporary artifacts used by the integration
 * tests. Everything lives under the `Workbench.Test` package so cleanup can
 * remove it with a single wildcard delete.
 */

export const TEST_PACKAGE = 'Workbench.Test';

export const SOURCE_CLASS = 'Workbench.Test.Source';
export const CUBE_NAME = 'WorkbenchTestSource';
export const BUSINESS_SERVICE_CLASS = 'Workbench.Test.BS';
export const BUSINESS_PROCESS_CLASS = 'Workbench.Test.BP';
export const TEST_PRODUCTION = 'Workbench.Test.Production';

/** A tiny persistent class with a seed method inserting ~20 rows. */
export const SOURCE_CLS = `Class ${SOURCE_CLASS} Extends %Persistent
{

Property Region As %String;

Property Product As %String;

Property Amount As %Numeric;

Property SaleDate As %Date;

/// Populate ~20 deterministic sample rows for cube tests.
ClassMethod Seed() As %Status
{
    Do ..%KillExtent()
    Set regions = $ListBuild("North","South","East","East")
    Set products = $ListBuild("Widget","Gadget","Gizmo","Doohickey")
    For i=1:1:20 {
        Set obj = ..%New()
        Set obj.Region = $List(regions, (i#4)+1)
        Set obj.Product = $List(products, (i#4)+1)
        Set obj.Amount = (i*10)+((i#3)*5)
        Set obj.SaleDate = +$Horolog - (i*3)
        Set sc = obj.%Save()
        If $$$ISERR(sc) Return sc
    }
    Return $$$OK
}

}`;

/** Minimal business service (adapterless). */
export const BUSINESS_SERVICE_CLS = `Class ${BUSINESS_SERVICE_CLASS} Extends Ens.BusinessService
{

Method OnProcessInput(pInput As %Persistent, Output pOutput As %Persistent) As %Status
{
    Return $$$OK
}

}`;

/// Business process. Ens.BusinessProcess.OnRequest requires request/response
/// arguments typed as %Persistent (or subclasses like Ens.Request/Ens.Response).
export const BUSINESS_PROCESS_CLS = `Class ${BUSINESS_PROCESS_CLASS} Extends Ens.BusinessProcess
{

Method OnRequest(pRequest As Ens.Request, Output pResponse As Ens.Response) As %Status
{
    Return $$$OK
}

}`;

/** Config-item name of the pre-seeded host in the throwaway production. */
export const TEST_PREEXISTING_ITEM = 'Workbench.Test.Seed';

/**
 * Config-item NAMES for the SQL-adapter interop test (no `.cls` — these register
 * pre-built IRIS interop classes via production settings, the way a SQL data
 * pipeline does). Two GenericServices share one Java Gateway so the test can
 * exercise ref-counting on delete.
 */
export const TEST_JAVA_GATEWAY_ITEM = 'Workbench.Test.JavaGateway';
export const TEST_SQL_SERVICE_A = 'Workbench.Test.SqlServiceA';
export const TEST_SQL_SERVICE_B = 'Workbench.Test.SqlServiceB';
export const JAVA_GATEWAY_CLASS = 'EnsLib.JavaGateway.Service';
export const SQL_GENERIC_SERVICE_CLASS = 'EnsLib.SQL.Service.GenericService';

/**
 * A production that already contains one item, so tests can prove that adding a
 * new host preserves existing items (the original bug wiped them). We can start
 * this when no other production is running.
 */
export const TEST_PRODUCTION_CLS = `Class ${TEST_PRODUCTION} Extends Ens.Production
{

XData ProductionDefinition
{
<Production Name="${TEST_PRODUCTION}" LogGeneralTraceEvents="false">
<Item Name="${TEST_PREEXISTING_ITEM}" Category="" ClassName="${BUSINESS_PROCESS_CLASS}" PoolSize="1" Enabled="false" Foreground="false" Comment="" LogTraceEvents="false" Schedule=""></Item>
</Production>
}

}`;
