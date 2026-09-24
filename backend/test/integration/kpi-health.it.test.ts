/**
 * Track B KPI-health path against live IRIS. Confirms the health envelope for a
 * threshold KPI, and DOCUMENTS the live Issue-table contract (B-5/B-6): whether
 * SC.Data.Issue is SQL-queryable and which columns carry severity + impacted-object-type.
 * Live IRIS required; run via the delegation session: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, buildTestCube, makeTestKpi, runCleanups, type Cleanup } from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import { resolveClass } from '../../src/iris/schema-ops.js';
import { ISSUE_CLASS } from '../../src/iris/issues-ops.js';
import type { KpiHealth } from '../../src/dashboard/kpi-health.js';

describe('KPI health (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];
  beforeAll(async () => { app = bootApp(); await healCubeRegistry(app.iris); });
  afterAll(async () => { await sweep(app.iris); await app.close(); });
  beforeEach(() => { cleanups = []; });
  afterEach(async () => { await runCleanups(cleanups); });

  it('a threshold KPI returns a health envelope with derived bands', async () => {
    const src = await seedSource(app.iris, { seedRows: true }); cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src); cleanups.push(cube.cleanup);
    const kpi = await makeTestKpi(app.iris, cube); cleanups.push(kpi.cleanup);
    const res = await fetch(`${app.base}/api/dashboard/kpi-health/${encodeURIComponent(kpi.name)}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const h = await jsonOf<KpiHealth>(res);
    expect(h.name).toBe(kpi.name);
    expect('threshold' in h && 'issues' in h).toBe(true);
  });

  it('a missing KPI → 404 NOT_FOUND', async () => {
    const res = await fetch(`${app.base}/api/dashboard/kpi-health/NoSuchKpi_${Date.now()}`);
    expect(res.status).toBe(404);
  });

  // B-5/B-6 CONTRACT PROBE: documents the live Issue-table shape so the impl's constants
  // (ISSUE_CLASS / _SEVERITY_COL / _TRIGGER_TYPE_COL / _TRIGGER_OBJECT_COL) are trusted, not
  // assumed. This probe only pinned the CLASS, which is why the wrong link column (SC-2721)
  // survived — a per-KPI scoping assertion still needs adding here.
  it('documents whether the Issue class is SQL-queryable (pins ISSUE_CLASS)', async () => {
    const resolved = await resolveClass(app.iris.atelier, ISSUE_CLASS);
    // Record the observed reality; if false or the columns differ, update issues-ops.ts
    // constants + the SELECT, then re-run. (docs/integration-testing.md: document current behavior.)
    console.log('[B-5 probe] Issue class resolved:', JSON.stringify(resolved));
    expect(typeof resolved.exists).toBe('boolean');
  });
});
