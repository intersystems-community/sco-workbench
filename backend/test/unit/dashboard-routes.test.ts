// backend/test/unit/dashboard-routes.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDashboardRouter } from '../../src/server/dashboard-routes.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import type { IrisServices } from '../../src/iris/index.js';
import type { Env } from '../../src/config/env.js';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/sqlite.js';
import { DashboardRepository } from '../../src/db/dashboards.js';
import { emptyDashboardConfig } from '../../src/dashboard/dashboard-config.js';
import mdxSample from './fixtures/mdx-result.sample.json' with { type: 'json' };

// The Layer-2 advisor (useAi branch) calls runOneShot → Bedrock. Mock it so the
// unit tier never spawns the CLI or reaches the model: it returns an unparseable
// string, which the advisor's fallback invariant turns into a Layer-1b spec with
// fallback:true — exactly the "AI failure is never a route error" case under test.
vi.mock('../../src/agent/agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/agent/agent.js')>()),
  runOneShot: async () => 'the model is unavailable in the unit tier',
}));

// A COMPLETE set of Bedrock settings: since the credentials became optional,
// `aiConfigured()` gates every AI path, and a fake env missing them puts these
// tests on the degraded "Claude key not provided" branch — which is not what they
// are about (see ai-availability.test.ts for that branch).
const fakeEnv = {
  ANTHROPIC_MODEL: 'test',
  AWS_REGION: 'us-east-1',
  AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-token',
} as unknown as Env;

/** deepsee.mdxExecute + the /Info/* filters/measures cubeStructure reads. */
function fakeIris(): IrisServices {
  return {
    // Two cube rows so the /chartable-cubes list has something to enrich. These
    // don't match 'SalesCube' by short-name, so resolveCubeClass returns null for
    // the other tests' shape reads (they keep degrading to the deepsee-only shape).
    atelier: {
      query: async () => [
        { Name: 'SC.Core.Analytics.Cube.ProductInventory', DependsOn: 'SC.Data.Product' },
        { Name: 'SC.Workbench.Cube.Residue', DependsOn: '' },
      ],
      readClass: async () => null,
    },
    deepsee: {
      // Cube-aware so the /chartable-cubes filter has a real 0-measure case: the
      // Residue cube reads empty (→ dropped), every other cube (incl. SalesCube)
      // keeps the Revenue/Region shape the other tests rely on.
      measures: async (cube: string) => (cube === 'Residue' ? [] : [{ name: 'Revenue', caption: 'Revenue' }]),
      filters: async (cube: string) => (cube === 'Residue' ? [] : [{ caption: 'Region', value: '[region].[H1].[region]' }]),
      listings: async () => [],
      mdxExecute: vi.fn().mockResolvedValue(mdxSample),
    },
    kpi: {
      list: async () => [
        { name: 'OnHand', label: 'On-Hand', type: 'DeepSee', deepseeKpiSpec: { cube: 'InvCube', valueType: 'raw', kpiDimensions: [{ name: 'quantityStatus', label: 'Status' }] } },
        { name: 'Manual', type: 'Manual' },
      ],
      get: async (name: string) => (name === 'OnHand'
        ? { name: 'OnHand', label: 'On-Hand', type: 'DeepSee', deepseeKpiSpec: { cube: 'InvCube', valueType: 'raw', kpiDimensions: [{ name: 'quantityStatus', label: 'Status' }] } }
        : null),
    },
    kpiValues: {
      values: async (_kpi: string, expandDimension?: string) => (expandDimension
        ? { status: 200, body: { kpiName: 'OnHand', expandDimension, values: [{ label: 'AboveMaximum', value: 11 }, { label: 'Normal', value: 24 }] } }
        : { status: 200, body: { kpiName: 'OnHand', values: [{ label: 'kpi', value: 35 }] } }),
    },
  } as unknown as IrisServices;
}

function startApp(iris: IrisServices): Promise<{ server: Server; baseUrl: string; db: Database.Database }> {
  const db = openDatabase(':memory:');
  const app: Express = express();
  app.use(express.json());
  app.use('/api/dashboard', createDashboardRouter(iris, fakeEnv, new DashboardRepository(db)));
  app.use(errorEnvelope(false));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, db }));
  });
}

let server: Server;
let db: Database.Database;
afterAll(async () => { db.close(); await new Promise<void>((r) => server.close(() => r())); });

describe('dashboard routes', () => {
  let baseUrl: string;
  beforeAll(async () => { ({ server, baseUrl, db } = await startApp(fakeIris())); });

  it('GET /cube-shape/:cube returns measures + tagged dimensions', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/cube-shape/SalesCube`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.measures.map((m: any) => m.name)).toContain('Revenue');
    expect(body.dimensions[0].kind).toBe('categorical');
  });

  it('GET /chartable-cubes lists EVERY cube with its measure/dimension counts', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chartable-cubes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Both cubes are returned now; the FE disables the non-chartable one from its counts.
    expect(body.cubes.map((c: any) => c.cubeName)).toEqual(['ProductInventory', 'Residue']);
    expect(body.cubes.find((c: any) => c.cubeName === 'ProductInventory')).toMatchObject({ measureCount: 1, dimensionCount: 1 });
    expect(body.cubes.find((c: any) => c.cubeName === 'Residue')).toMatchObject({ measureCount: 0, dimensionCount: 0 });
  });

  it('POST /chart-data {source:cube} returns ChartData + applicableTypes for the dropdown filter', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [{ name: 'region', role: 'category' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('meta.dimensionKind');
    // applicableTypes rides alongside so the FE offers only truthful types. A one-series
    // categorical set → cartesian + pie/treemap, but never gauge/dumbbell/heatmap.
    expect(Array.isArray(body.applicableTypes)).toBe(true);
    expect(body.applicableTypes).toContain('bar');
    expect(body.applicableTypes).toContain('pie');
    expect(body.applicableTypes).not.toContain('solidgauge');
    expect(body.applicableTypes).not.toContain('dumbbell');
  });

  it('POST /chart-data with an unknown measure → 404 with candidates', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'cube', cube: 'SalesCube', measures: ['Nope'], dimensions: [{ name: 'region', role: 'category' }] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe('NOT_FOUND');
    expect(Array.isArray(body.candidates)).toBe(true);
  });

  it('POST /chart-spec {ChartData} with no type → Layer 1b, returns spec + type + layer + intent', async () => {
    // Three categories (not two): a one-series categorical shape with no populated matrix
    // cell → the shape-default branch. With this task's orientation heuristic a few short
    // labels read as column (bar for many/long); this route test pins the 1b envelope
    // fields (layer/intent/source/recommendedType), not the orientation itself — that is
    // covered in chart-type-advisor.test.ts. Two categories would fire the `slope` signal
    // (source 'matrix'), covered there too.
    const chartData = { categories: ['a', 'b', 'c'], series: [{ name: 's', data: [1, 2, 3] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } };
    const res = await fetch(`${baseUrl}/api/dashboard/chart-spec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chartData }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.layer).toBe('1b');
    expect(body.spec).toBeDefined();
    expect(body.type).toBeDefined();
    // Change 10: the derived analytic intent rides along so the FE can explain WHY.
    expect(body.intent).toBe('comparison'); // one-series categorical → comparison
    expect(body.source).toBe('shape-default');
    // The recommended type rides EVERY chart-spec response so the FE "Recommended"
    // option can name it; on a 1b it equals `type` (the recommendation IS what was built).
    expect(body.recommendedType).toBe(body.type);
  });

  it('POST /chart-spec {ChartData, type} → Layer 1a faithful build', async () => {
    // A single SCALAR value: the advisor recommends the gauge (single-value intent),
    // so an explicit `bar` override lets us prove recommendedType names the advisor's
    // choice, NOT the overridden one.
    const chartData = { categories: ['a'], series: [{ name: 's', data: [1] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar' } };
    const res = await fetch(`${baseUrl}/api/dashboard/chart-spec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chartData, type: 'bar' }),
    });
    const body = (await res.json()) as any;
    expect(body.layer).toBe('1a');
    expect(body.intent).toBeUndefined(); // an explicit override carries no rationale
    // Even under an explicit override, the response names what the advisor WOULD
    // recommend, so the FE "Recommended (…)" label stays truthful while a different
    // type is drawn.
    expect(body.type).toBe('bar');
    expect(body.recommendedType).toBe('solidgauge');
  });

  it('POST /chart-spec with a negative value into pie → 400 VALIDATION', async () => {
    const chartData = { categories: ['a', 'b'], series: [{ name: 's', data: [1, -2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } };
    const res = await fetch(`${baseUrl}/api/dashboard/chart-spec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chartData, type: 'pie' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('VALIDATION');
  });

  it('GET /ai-health reports availability (the mocked runOneShot resolves → available)', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/ai-health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // The suite-wide mock makes runOneShot RESOLVE (returns a string), so the probe
    // sees a reachable model. The proactive breaker keys the FE grey-out on this.
    expect(body.available).toBe(true);
  });

  it('POST /chart-spec {useAi:true} that falls back returns 200 with fallback:true', async () => {
    // With the fake env, the advisor's LLM yields nothing parseable → fallback.
    const chartData = { categories: ['a', 'b'], series: [{ name: 's', data: [1, 2] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical' } };
    const res = await fetch(`${baseUrl}/api/dashboard/chart-spec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chartData, useAi: true }),
    });
    expect(res.status).toBe(200); // an AI failure is NEVER a route error
    const body = (await res.json()) as any;
    expect(body.layer).toBe('2');
    expect(body.fallback).toBe(true);
    expect(body.spec).toBeDefined();
    expect(body.intent).toBeUndefined(); // AI layer sends no deterministic intent
  });

  it('GET /kpis lists only DeepSee KPIs with their dimensions', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/kpis`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.kpis.map((k: any) => k.name)).toEqual(['OnHand']); // the Manual KPI is dropped
    expect(body.kpis[0].dimensions).toEqual([{ name: 'quantityStatus', label: 'Status' }]);
  });

  it('POST /chart-data {source:kpi} scalar → gauge-capable ChartData', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: 'OnHand' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.meta.dimensionKind).toBe('scalar');
    expect(body.applicableTypes).toContain('solidgauge');
  });

  it('POST /chart-data {source:kpi, expandDimension} → categories from the members', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: 'OnHand', expandDimension: 'quantityStatus' }),
    });
    const body = (await res.json()) as any;
    expect(body.categories).toEqual(['AboveMaximum', 'Normal']);
    expect(body.applicableTypes).toContain('bar');
  });

  it('POST /chart-data {source:kpi} with a bad expandDimension → 404 NOT_FOUND', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: 'OnHand', expandDimension: 'nope' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe('NOT_FOUND');
  });

  it('POST /chart-data with an unknown source → 400 VALIDATION', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('VALIDATION');
  });

  it('POST /chart-data {source:cube} THREADS a series dimension into the query (unknown → 404)', async () => {
    // The fake shape exposes exactly one dimension ('region'). If the route threads
    // dimensions[], CubeQueryRunner validates the series dim against the shape and rejects
    // an unknown one with NotFoundError → 404. If the route DROPS it (the bug), the field
    // is ignored and the query succeeds (200). So a 404 here is the wiring proof.
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [
        { name: 'region', role: 'category' }, { name: 'not-a-dimension', role: 'series' },
      ] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe('NOT_FOUND');
  });

  it('POST /chart-data {source:cube} with a filter member composes a WHERE at the route (200)', async () => {
    // Build a LOCAL app so we can capture the mdxExecute the route drives. The fake's ONE
    // dimension is 'region'; filter-member validation reads members via mdxExecute, which
    // returns mdxSample — whose Axis 0 members are ['Total Order Value','%chartTotal']. So a
    // filter member of 'Total Order Value' validates. Filtering region with no category is the
    // scalar-plus-WHERE combo (also proven as a unit in Task 5): SELECT {measures} ON 0 WHERE(...).
    const iris = fakeIris();
    const captured = iris.deepsee.mdxExecute as ReturnType<typeof vi.fn>;
    const local = await startApp(iris);
    try {
      const res = await fetch(`${local.baseUrl}/api/dashboard/chart-data`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [
          { name: 'region', role: 'filter', member: 'Total Order Value' },
        ] }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      // The LAST mdxExecute is the chart query (the members read fires first, during validation).
      const lastMdx = captured.mock.calls.at(-1)![0] as string;
      expect(lastMdx).toContain('WHERE (');
    } finally {
      local.db.close();
      await new Promise<void>((r) => local.server.close(() => r()));
    }
  });

  it('POST /chart-data {source:cube} 404s an unknown filter member before the chart query', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'cube', cube: 'SalesCube', measures: ['Revenue'], dimensions: [
        { name: 'region', role: 'filter', member: 'no-such-member' },
      ] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe('NOT_FOUND');
  });

  describe('GET /cube-members/:cube/:dimension', () => {
    it('returns the dimension members off Axis 0', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/cube-members/SalesCube/region`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // mdxSample's Axis_0 members drive the members read via the same fixture — assert it
      // is a non-empty member array (precise parsing is covered in cube-members.test.ts).
      expect(Array.isArray(body.members)).toBe(true);
      expect(body.members.length).toBeGreaterThan(0);
      expect(body.members[0]).toHaveProperty('name');
    });

    it('forwards the optional ?level= query param to the reader (B-CUBE-15)', async () => {
      // The fake shape's 'region' dimension has one level; passing its spec must be accepted (200)
      // and reach the reader as the 3rd arg. An unknown level would 404 (covered as a unit in Task 4).
      const iris = fakeIris();
      const spy = vi.spyOn(iris.deepsee, 'mdxExecute');
      const local = await startApp(iris);
      try {
        const regionLevel = '[region].[H1].[region]'; // the fake shape's sole region level spec (from filters())
        const res = await fetch(`${local.baseUrl}/api/dashboard/cube-members/SalesCube/region?level=${encodeURIComponent(regionLevel)}`);
        expect(res.status, await res.clone().text()).toBe(200);
        // The composed MEMBERS MDX enumerates that level spec.
        expect(spy.mock.calls.at(-1)![0]).toContain(`${regionLevel}.MEMBERS`);
      } finally {
        local.db.close();
        await new Promise<void>((r) => local.server.close(() => r()));
      }
    });

    it('404s an unknown dimension', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/cube-members/SalesCube/nope`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).code).toBe('NOT_FOUND');
    });
  });

  describe('POST /chart-spec', () => {
    // A two-series, non-negative, homogeneous shape: stackable, so the happy paths hold.
    const stackable = { categories: ['North', 'South'], series: [{ name: '24', data: [10, 20] }, { name: '25', data: [12, 18] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Year' } };
    const post = (body: unknown) => fetch(`${baseUrl}/api/dashboard/chart-spec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('a supported type → echarts spec, no fallback', async () => {
      const res = await post({ chartData: stackable, type: 'stackedColumn' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.fallback).toBeFalsy();
      expect(body.spec.series[0].type).toBe('bar'); // echarts stackedColumn = bar + stack
    });

    it('an out-of-band type → 400 VALIDATION (no real type falls back after full parity)', async () => {
      // A token outside the ChartType union is the ONLY thing the builder can't place: echarts
      // supports all 18 real types. The route builds on the one ECharts builder directly, whose
      // build() out-of-band guard rejects the token → BuilderRejection → 400 VALIDATION. So there
      // is no 200-fallback route path for an unsupported type.
      const res = await post({ chartData: stackable, type: 'gantt' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).code).toBe('VALIDATION');
    });

    it('an absent type builds the recommended echarts spec (multi-series 1b)', async () => {
      // No `type` → the 1b recommendation path, exercised here on a MULTI-series shape
      // (the single-series 1b path is covered at the top of this file). The response is a
      // real echarts spec and, on 1b, `recommendedType` equals the `type` actually built.
      const res = await post({ chartData: stackable });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.layer).toBe('1b');
      expect(body.spec).toBeDefined();
      expect(body.type).toBeDefined();
      expect(body.recommendedType).toBe(body.type);
    });

    // (Removed 2026-08-28, signed off: 'unknown renderer → 400' — route-level renderer
    //  validation is retired by the ECharts force; the `renderer` request field is inert.)

    it('a BuilderRejection is a 400 even on a "supported" echarts type (distinct from a 200 fallback)', async () => {
      // stackedColumn over single-series data → BuilderRejection, though echarts supports stackedColumn.
      const single = { categories: ['a'], series: [{ name: 's', data: [1] }], meta: { truncated: false, shown: 1, dimensionKind: 'categorical' } };
      const res = await post({ chartData: single, type: 'stackedColumn', renderer: 'echarts' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).code).toBe('VALIDATION');
    });

    it('/chart-spec threads funnelSort into the funnel spec (source order → sort:none)', async () => {
      // The FE Order toggle sends `funnelSort` beside `type:'funnel'`; the route must read it
      // (dashboard-routes.ts:150-151) and thread it as `opts` into build(). The render maps
      // 'source' → ECharts sort:'none' (echarts-spec-builder.ts:147). A one-series, non-negative
      // categorical shape is exactly what capabilityFor offers 'funnel' for.
      const funnelData = { categories: ['A', 'B', 'C'], series: [{ name: 'Users', data: [100, 40, 12] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } };
      const res = await post({ chartData: funnelData, type: 'funnel', funnelSort: 'source' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.spec.series[0].type).toBe('funnel');
      expect(body.spec.series[0].sort).toBe('none'); // source order → none (NOT the default 'descending')
    });

    it('/chart-spec funnel WITHOUT funnelSort defaults to descending (value order)', async () => {
      // The default value order proves the source-order assertion above is load-bearing:
      // absent funnelSort, plan() sets sort 'value' → render maps to ECharts 'descending'.
      const funnelData = { categories: ['A', 'B', 'C'], series: [{ name: 'Users', data: [100, 40, 12] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical' } };
      const res = await post({ chartData: funnelData, type: 'funnel' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.spec.series[0].type).toBe('funnel');
      expect(body.spec.series[0].sort).toBe('descending');
    });
  });

  describe('dashboard layout persistence', () => {
    const valid = {
      schemaVersion: 1,
      tiles: [{ id: 't1', kind: 'table', layout: { w: 1, h: 1 }, selection: { table: 'SC.Data.Product' } }],
    };

    it('GET /layout on an empty store returns an empty config (no write-back — DA-SPEC-06)', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/layout`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).config).toEqual(emptyDashboardConfig());
      // The pure read must not have created a row.
      const count = (db.prepare('SELECT COUNT(*) n FROM dashboards').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('PUT /layout validates + persists, and GET reads it back', async () => {
      const put = await fetch(`${baseUrl}/api/dashboard/layout`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: valid }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ ok: true });
      const got = (await (await fetch(`${baseUrl}/api/dashboard/layout`)).json()) as any;
      expect(got.config.tiles).toHaveLength(1);
    });

    it('round-trips a general multi-measure + level-granular + filter cube tile through PUT → GET', async () => {
      const cfg = { schemaVersion: 1, tiles: [{
        id: 'c1', kind: 'chart', layout: { w: 2, h: 1 },
        selection: { source: 'cube', cube: 'SalesCube', measures: ['Revenue', 'Units'], dimensions: [
          { name: 'customer', role: 'category', level: '[customer].[H1].[CustomerName]' }, // B-CUBE-15 level survives persistence
          { name: 'year', role: 'filter', member: '2024' },
        ], chartType: 'bar' },
      }] };
      const put = await fetch(`${baseUrl}/api/dashboard/layout`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: cfg }),
      });
      expect(put.status).toBe(200);
      const got = (await (await fetch(`${baseUrl}/api/dashboard/layout`)).json()) as any;
      const sel = got.config.tiles[0].selection;
      expect(sel.measures).toEqual(['Revenue', 'Units']);
      expect(sel.dimensions).toContainEqual({ name: 'customer', role: 'category', level: '[customer].[H1].[CustomerName]' });
      expect(sel.dimensions).toContainEqual({ name: 'year', role: 'filter', member: '2024' });
    });

    it('PUT /layout with an invalid config → 400 VALIDATION', async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/layout`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: { schemaVersion: 1, tiles: [{ id: 'x', kind: 'chart', layout: { w: 9, h: 1 }, selection: { source: 'cube' } }] } }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).code).toBe('VALIDATION');
    });

    it('GET /layout on a malformed/unknown-version row returns empty AND leaves the row byte-unchanged (DA-SPEC-06)', async () => {
      // Seed a row a newer build might have written (unknown schemaVersion) via a direct insert.
      db.prepare(`INSERT INTO dashboards (id,name,config_json,updated_at) VALUES ('default','D',@c,'2020')
                  ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`)
        .run({ c: JSON.stringify({ schemaVersion: 99, tiles: [] }) });
      const res = await fetch(`${baseUrl}/api/dashboard/layout`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).config).toEqual(emptyDashboardConfig());
      const raw = db.prepare(`SELECT config_json FROM dashboards WHERE id='default'`).get() as { config_json: string };
      expect(JSON.parse(raw.config_json).schemaVersion).toBe(99); // untouched — no destructive read
    });
  });
});
