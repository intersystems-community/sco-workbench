/**
 * SC-2664 (second change) / advisor recommendation-vocabulary coverage live IRIS+SCO
 * integration test: a FEW, SHORT-labelled categorical cube query auto-recommends COLUMN,
 * not bar. Proves the orientation heuristic end-to-end (chart-type-advisor.ts:85 prefersColumn
 * → the :128 shape-default fallback). Sibling to slope-heuristics.it.test.ts; same RegionD
 * fixture (North/South/East, provision.ts:503, 3 short members) queried at topN: 3.
 * Self-provisioning + self-cleaning on the clean-SCO baseline. Live IRIS required; run via:
 * npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, runCleanups, type Cleanup } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';

describe('advisor orientation: a few short categorical members auto-recommend column (live)', () => {
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

  it('a categorical query bounded to three short members recommends column, not bar', async () => {
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

    // topN: 3 → IRIS TOPCOUNT returns the three RegionD members (North/South/East — all ≤ 5 chars,
    // provision.ts:503) to the advisor: a few AND short-labelled categorical axis, one measure.
    const dataRes = await post('/api/dashboard/chart-data', {
      source: 'cube', cube: cube.cubeName, measures: ['Total'],
      dimensions: [{ name: regionDim!.name, role: 'category' }], topN: 3,
    });
    expect(dataRes.status, await dataRes.clone().text()).toBe(200);
    const data = await jsonOf<ChartData>(dataRes);
    // The shape the fix targets: a few short categorical members (the orientation heuristic's
    // fires-case). If the live cube seeds differently — more members, or labels > 10 chars — the
    // honest pick would be bar; do NOT force column (spec §7). Report the actual shape to Karsten.
    expect(data.categories.length).toBe(3);
    expect(data.meta.dimensionKind).toBe('categorical');
    expect(Math.max(...data.categories.map((c) => c.length))).toBeLessThanOrEqual(10);

    // Layer-1b: no explicit type → the deterministic advisor picks. It falls through signalType +
    // matrixType (comparison has no matrix cell) to the shape-default fallback, where the orientation
    // heuristic makes a few-short categorical axis a COLUMN, not the orientation-agnostic bar.
    // Reads the /chart-spec ENVELOPE ({ type, layer, source, ... }, dashboard-routes.ts:175), named
    // recEnvelope to match the sibling slope it-test.
    const recRes = await post('/api/dashboard/chart-spec', { chartData: data });
    expect(recRes.status, await recRes.clone().text()).toBe(200);
    const recEnvelope = await jsonOf<{ type: string; layer: string; source: string }>(recRes);
    expect(recEnvelope.layer).toBe('1b');
    expect(recEnvelope.source).toBe('shape-default'); // an empty matrix cell → the honest fallback
    expect(recEnvelope.type).toBe('column');          // orientation heuristic: few short members read better as columns
  });
});
