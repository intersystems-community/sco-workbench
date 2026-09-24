/**
 * CLI: create ONE correct, fully-filled, editable example cube in the Workbench
 * cube package (SC.Workbench.Cube.*), so users can open it in Analytics Cubes,
 * see a complete definition, and edit it as a working example.
 *
 * Usage:  npm run seed:example-cube
 *
 * Reads IRIS connection from .env. The cube is built over SC.Data.SalesOrder
 * (part of the SCO package) and demonstrates every field family the Workbench
 * supports: a data dimension, a multi-level time dimension (Year→Month→Day),
 * and SUM/AVG/MAX measures. It goes through the same generate→compile→build
 * pipeline the REST route uses, so what you get is exactly a normal Workbench
 * cube — fully editable and deletable in the UI.
 */
import { loadEnv } from '../src/config/env.js';
import { createIrisServices } from '../src/iris/index.js';
import { resolveClass } from '../src/iris/schema-ops.js';
import { generateCubeClass, cubeClassName } from '../src/cube/cube-generator.js';
import { buildCube } from '../src/iris/cube-ops.js';
import type { CubeDefinition } from '../src/cube/cube-definition.model.js';

const EXAMPLE_CUBE = 'WorkbenchExampleSalesCube';

/** The example definition — one of everything the Workbench form supports. */
function exampleDefinition(sourceClass: string): CubeDefinition {
  return {
    cubeName: EXAMPLE_CUBE,
    sourceClass,
    displayName: 'Workbench Example — Sales',
    description: 'A complete, editable example cube built by the Workbench over sales orders.',
    dimensions: [
      {
        name: 'SalesRegionD',
        type: 'data',
        hasAll: true,
        hierarchies: [
          {
            name: 'H1',
            levels: [
              { name: 'SalesRegion', displayName: 'Sales Region', sourceProperty: 'salesRegion', nullReplacement: 'Unknown', factNumber: 2 },
            ],
          },
        ],
      },
      {
        name: 'OrderStatusD',
        type: 'data',
        hasAll: true,
        hierarchies: [
          {
            name: 'H1',
            levels: [{ name: 'OrderStatus', displayName: 'Order Status', sourceProperty: 'orderStatus', factNumber: 3 }],
          },
        ],
      },
      {
        name: 'OrderPlacedDateD',
        type: 'time',
        hasAll: true,
        hierarchies: [
          {
            name: 'H1',
            levels: [
              { name: 'Year', displayName: 'Order Year', sourceProperty: 'orderPlacedDate', timeFunction: 'Year', factNumber: 4 },
              { name: 'Month', displayName: 'Order Month', sourceProperty: 'orderPlacedDate', timeFunction: 'MonthYear', factNumber: 5 },
              { name: 'Day', displayName: 'Order Day', sourceProperty: 'orderPlacedDate', timeFunction: 'DayMonthYear', factNumber: 6 },
            ],
          },
        ],
      },
    ],
    // Multiple measures over the SAME source property (orderValue) must share
    // one factName — IRIS stores the source once and aggregates it multiple
    // ways; distinct factNames on the same source collide (#5001 "Multiple fact
    // numbers defined for factID"). This mirrors SCO's own SalesOrderCube.
    measures: [
      { name: 'TotalRevenue', displayName: 'Total Revenue', sourceProperty: 'orderValue', factName: 'MxorderValue', aggregate: 'SUM', type: 'number', factNumber: 7 },
      { name: 'AverageOrderValue', displayName: 'Average Order Value', sourceProperty: 'orderValue', factName: 'MxorderValue', aggregate: 'AVG', type: 'number', factNumber: 8 },
      { name: 'MaxOrderValue', displayName: 'Max Order Value', sourceProperty: 'orderValue', factName: 'MxorderValue', aggregate: 'MAX', type: 'number', factNumber: 9 },
    ],
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const iris = createIrisServices(env);
  const log = (m: string) => console.log(`  • ${m}`); // eslint-disable-line no-console
  // eslint-disable-next-line no-console
  console.log(`Seeding example cube "${EXAMPLE_CUBE}" on IRIS ns ${env.SCO_NAMESPACE} @ ${env.SCO_HOST}…`);
  try {
    // Resolve the source class (SalesOrder → SC.Data.SalesOrder) so DependsOn is valid.
    const wanted = 'SC.Data.SalesOrder';
    const resolved = await resolveClass(iris.atelier, wanted);
    if (!resolved.exists || !resolved.className) {
      throw new Error(
        `Source class "${wanted}" not found — is the SCO package installed? Candidates: ${(resolved.candidates ?? []).join(', ')}`,
      );
    }
    const def = exampleDefinition(resolved.className);

    const className = cubeClassName(def.cubeName);
    const source = generateCubeClass(def);
    log(`Compiling ${className} …`);
    const compile = await iris.atelier.importAndCompile(className, source);
    if (!compile.ok) {
      throw new Error(`Compile failed:\n${compile.errors.join('\n')}\n${compile.console.join('\n')}`);
    }
    log('Compiled. Building (populating) the cube …');
    const built = buildCube(iris.native, def.cubeName);
    if (!built.ok) throw new Error(built.message);
    log(built.message);
    // eslint-disable-next-line no-console
    console.log(
      `Done. Open "Analytics Cubes" in the Workbench — "${def.displayName}" is editable (source: ${resolved.className}).`,
    );
  } finally {
    iris.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
