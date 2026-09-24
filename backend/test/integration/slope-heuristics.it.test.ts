/**
 * SC-2664 / D8 live IRIS+SCO integration test: a two-category CATEGORICAL cube query
 * auto-recommends a column, NEVER slope. Proves the temporal-only slope narrowing end-to-end
 * (chart-type-advisor.ts:83); the two SHORT nominal members also exercise the SC-2664 change-2
 * orientation heuristic, so the honest non-slope pick is a column, not a bar.
 * Self-provisioning + self-cleaning on the clean-SCO baseline.
 * Live IRIS required; run via: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, runCleanups, type Cleanup } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';

describe('D8 slope heuristics: two nominal categories do not auto-slope (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
  });
  afterAll(async () => {
    await sweep(app.iris);
    await app.close();
  });
  beforeEach(() => { cleanups = []; });
  afterEach(async () => { await runCleanups(cleanups); });

  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('a categorical query bounded to two members recommends a column, not slope', async () => {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src); // minimal Region/Amount cube
    cleanups.push(cube.cleanup);

    // Resolve the region dimension name from the shape (don't hard-code it).
    const shapeRes = await fetch(`${app.base}/api/dashboard/cube-shape/${cube.cubeName}`);
    expect(shapeRes.status, await shapeRes.clone().text()).toBe(200);
    const shape = await jsonOf<{ dimensions: { name: string; kind: string }[] }>(shapeRes);
    const regionDim = shape.dimensions.find((d) => d.name.toLowerCase().includes('region'));
    expect(regionDim, 'RegionD dimension present').toBeTruthy();
    // The region dimension is categorical (never temporal) — the shape this test needs.
    expect(regionDim!.kind).toBe('categorical');

    // topN: 2 → IRIS TOPCOUNT returns exactly two categorical members to the advisor.
    const dataRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'],
      dimensions: [{ name: regionDim!.name, role: 'category' }], topN: 2,
    });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(dataRes);
    // The shape the fix targets: exactly two categorical members.
    expect(data.categories.length).toBe(2);
    expect(data.meta.dimensionKind).toBe('categorical');

    // Layer-1b: no explicit type → the deterministic advisor picks. It must be bar, NOT slope.
    // NB: this reads the top level of the /chart-spec ENVELOPE ({ spec, type, layer, source, ... },
    // dashboard-routes.ts:175). Named recEnvelope, not `spec`, to avoid colliding with the nested
    // `spec` render object the sibling it-tests bind (reviewer CONSIDER D8-PLAN-02).
    const recRes = await post('/api/dashboard/chart-spec', { chartData: data });
    expect(recRes.status, await recRes.clone().text()).toBe(200);
    const recEnvelope = await jsonOf<{ type: string; layer: string; source: string }>(recRes);
    expect(recEnvelope.layer).toBe('1b');
    expect(recEnvelope.type).not.toBe('slope'); // the crux: the over-eager slope is gone (D8)
    expect(recEnvelope.type).toBe('column');    // two SHORT nominal categories now read as columns (orientation heuristic, SC-2664 change 2); slope narrowing (the crux above) is unaffected
  });
});
