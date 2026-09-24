/**
 * SCRATCH (not part of D2): seed ONE chartable Workbench cube on a bare
 * community IRIS that has no SCO / no SC.Data.SalesOrder. Authors its own
 * source persistent class with a Seed(), then runs the app's real
 * generate→compile→build pipeline so the result is a normal, editable
 * Workbench cube the dashboard can chart.
 *
 * Usage (from backend/, env pointing at the target IRIS):
 *   npx tsx scripts/seed-demo-cube.ts
 *
 * Cube shape mirrors the proven integration-test cube (RegionD data dim +
 * SUM measure over a %Numeric) plus a Product data dim, a Year→Month time
 * dim, and AVG/MAX measures — so the chart panel has multiple dimensions and
 * measures to pick. Multiple measures over the SAME source property share one
 * factName (distinct factNames on one source collide, #5001).
 */
import { loadEnv } from '../src/config/env.js';
import { createIrisServices } from '../src/iris/index.js';
import { generateCubeClass, cubeClassName } from '../src/cube/cube-generator.js';
import { buildCube } from '../src/iris/cube-ops.js';
import type { CubeDefinition } from '../src/cube/cube-definition.model.js';

const SOURCE_CLASS = 'Workbench.Demo.SalesSource';
const CUBE_NAME = 'WorkbenchDemoSales';
const ROWS = 60;

/** A persistent class with a Seed() inserting deterministic, chartable rows. */
function sourceClass(className: string): string {
  return `Class ${className} Extends %Persistent
{

Property Region As %String;

Property Product As %String;

Property Amount As %Numeric;

Property Units As %Integer;

Property SaleDate As %Date;

/// Populate ${ROWS} deterministic sample rows across regions, products and months.
ClassMethod Seed() As %Status
{
    Do ..%KillExtent()
    Set regions = $ListBuild("North","South","East","West")
    Set products = $ListBuild("Widget","Gadget","Gizmo","Doohickey")
    For i=1:1:${ROWS} {
        Set obj = ..%New()
        Set obj.Region = $List(regions, (i#4)+1)
        Set obj.Product = $List(products, (i#4)+1)
        Set obj.Amount = (i*10)+((i#5)*25)
        Set obj.Units = (i#7)+1
        // Spread across ~12 months so the time dimension has range.
        Set obj.SaleDate = +$Horolog - (i*20)
        Set sc = obj.%Save()
        If $$$ISERR(sc) Return sc
    }
    Return $$$OK
}

}`;
}

/** A multi-dimension, multi-measure cube over the demo source. */
function demoDefinition(sourceClass: string): CubeDefinition {
  return {
    cubeName: CUBE_NAME,
    sourceClass,
    displayName: 'Workbench Demo — Sales',
    description: 'A chartable demo cube authored by seed-demo-cube for D2 inspection.',
    dimensions: [
      {
        name: 'RegionD',
        type: 'data',
        hasAll: true,
        hierarchies: [
          { name: 'H1', levels: [{ name: 'Region', displayName: 'Region', sourceProperty: 'Region', factNumber: 2 }] },
        ],
      },
      {
        name: 'ProductD',
        type: 'data',
        hasAll: true,
        hierarchies: [
          { name: 'H1', levels: [{ name: 'Product', displayName: 'Product', sourceProperty: 'Product', factNumber: 3 }] },
        ],
      },
      {
        name: 'SaleDateD',
        type: 'time',
        hasAll: true,
        hierarchies: [
          {
            name: 'H1',
            levels: [
              { name: 'Year', displayName: 'Sale Year', sourceProperty: 'SaleDate', timeFunction: 'Year', factNumber: 4 },
              { name: 'Month', displayName: 'Sale Month', sourceProperty: 'SaleDate', timeFunction: 'MonthYear', factNumber: 5 },
            ],
          },
        ],
      },
    ],
    measures: [
      { name: 'Total', displayName: 'Total Amount', sourceProperty: 'Amount', factName: 'MxAmount', aggregate: 'SUM', type: 'number', factNumber: 6 },
      { name: 'AvgAmount', displayName: 'Average Amount', sourceProperty: 'Amount', factName: 'MxAmount', aggregate: 'AVG', type: 'number', factNumber: 7 },
      { name: 'MaxAmount', displayName: 'Max Amount', sourceProperty: 'Amount', factName: 'MxAmount', aggregate: 'MAX', type: 'number', factNumber: 8 },
      { name: 'TotalUnits', displayName: 'Total Units', sourceProperty: 'Units', factName: 'MxUnits', aggregate: 'SUM', type: 'integer', factNumber: 9 },
    ],
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const iris = createIrisServices(env);
  const log = (m: string) => console.log(`  • ${m}`); // eslint-disable-line no-console
  // eslint-disable-next-line no-console
  console.log(`Seeding demo cube "${CUBE_NAME}" on IRIS ns ${env.SCO_NAMESPACE} @ ${env.SCO_HOST}…`);
  try {
    // 1. Author + compile the source class.
    log(`Compiling source class ${SOURCE_CLASS} …`);
    const srcCompile = await iris.atelier.importAndCompile(SOURCE_CLASS, sourceClass(SOURCE_CLASS));
    if (!srcCompile.ok) {
      throw new Error(`Source compile failed:\n${srcCompile.errors.join('\n')}\n${srcCompile.console.join('\n')}`);
    }
    // 2. Seed rows.
    log(`Seeding ${ROWS} rows …`);
    const seedStatus = iris.native.callValue(SOURCE_CLASS, 'Seed');
    const seedDecoded = iris.native.decodeStatus(seedStatus);
    if (!seedDecoded.ok) throw new Error(`Seed failed: ${seedDecoded.text}`);

    // 3. Generate + compile + build the cube.
    const def = demoDefinition(SOURCE_CLASS);
    const className = cubeClassName(def.cubeName);
    log(`Compiling cube ${className} …`);
    const cubeCompile = await iris.atelier.importAndCompile(className, generateCubeClass(def));
    if (!cubeCompile.ok) {
      throw new Error(`Cube compile failed:\n${cubeCompile.errors.join('\n')}\n${cubeCompile.console.join('\n')}`);
    }
    log('Building (populating) the cube …');
    const built = buildCube(iris.native, def.cubeName);
    if (!built.ok) throw new Error(built.message);
    log(built.message);
    // eslint-disable-next-line no-console
    console.log(`Done. Cube "${def.displayName}" (${def.cubeName}) is built and chartable.`);
  } finally {
    iris.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
