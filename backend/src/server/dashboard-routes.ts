// backend/src/server/dashboard-routes.ts
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { IrisServices } from '../iris/index.js';
import type { Env } from '../config/env.js';
import { toIrisError } from '../iris/normalize-error.js';
import { ValidationError } from '../iris/iris-error.js';
import { DeepSeeShapeAdapter } from '../dashboard/cube-shape.js';
import { CubeQueryRunner } from '../dashboard/cube-query.js';
import { DeepSeeMemberReader } from '../dashboard/cube-members.js';
import { recommend } from '../dashboard/chart-type-advisor.js';
import { capabilityFor, BuilderRejection } from '../dashboard/chart-plan.js';
import { echartsBuilder } from '../dashboard/echarts-spec-builder.js';
import { LlmAuditAdvisor } from '../dashboard/chart-spec-advisor.js';
import { AiHealthProbe } from '../dashboard/ai-health.js';
import { AtelierCubeCatalog, ChartableCubeFinder } from '../dashboard/chartable-cubes.js';
import type { ChartData, ChartType } from '../dashboard/chart-data.js';
import { KpiValueReader } from '../dashboard/kpi-values.js';
import { KpiHealthReader } from '../dashboard/kpi-health.js';
import { IrisIssuesReader } from '../iris/issues-ops.js';
import { toChartableKpis } from '../dashboard/chartable-kpis.js';
import type { DashboardRepository } from '../db/dashboards.js';
import { validateDashboardConfig, emptyDashboardConfig } from '../dashboard/dashboard-config.js';

const DEFAULT_ID = 'default';
const DEFAULT_NAME = 'Dashboard';

/**
 * Routes for the Dashboard. Sibling of /api/data-browser (D1). MUST be in
 * LOCAL_API_PREFIXES (iris-proxy.ts) or every route is forwarded to IRIS and 404s.
 * Charting is stateless: /chart-data does the IRIS read; /chart-spec is a pure
 * presentation transform over ChartData the client kept — re-typing or asking AI
 * never re-queries. The layout routes (GET/PUT /layout) persist the saved dashboard
 * via DashboardRepository. The router is HTTP↔core translation only; all logic
 * lives in backend/src/dashboard.
 */
export function createDashboardRouter(iris: IrisServices, env: Env, dashboards: DashboardRepository): Router {
  const router = Router();
  const shapeReader = new DeepSeeShapeAdapter(iris.deepsee, iris.atelier);
  const memberReader = new DeepSeeMemberReader(shapeReader, iris.deepsee);
  const cubeRunner = new CubeQueryRunner(shapeReader, iris.deepsee, memberReader);
  const chartableCubes = new ChartableCubeFinder(new AtelierCubeCatalog(iris.atelier), shapeReader);
  const kpiReader = new KpiValueReader(iris.kpiValues, iris.kpi, shapeReader);
  // KPI health read model (Track B): def + derived bands + status + issues, in one envelope.
  // IssuesReader runs over iris.atelier, which already satisfies SqlQuerier (row-count precedent).
  const kpiHealthReader = new KpiHealthReader(iris.kpi, iris.kpiValues, new IrisIssuesReader(iris.atelier));
  // One probe per router so its short-TTL cache is shared across every request —
  // a page-load fan-out costs one real Bedrock round-trip, not one per client.
  const aiHealth = new AiHealthProbe(env);

  // The proactive half of the AI circuit breaker: the panel calls this on init to
  // pre-grey "Ask AI" when the LLM is unreachable (present-but-invalid creds — the
  // 403 case), instead of only learning after the user's first click. NEVER throws:
  // an unreachable model is a 200 { available:false }, not a route error.
  router.get('/ai-health', async (_req: Request, res: Response) => {
    return res.json(await aiHealth.check());
  });

  // Lists EVERY cube with its measure/dimension counts (Change 1). The picker
  // partitions on the counts (≥1 measure AND ≥1 dimension for chartable) and
  // disables non-chartable cubes, giving users transparency. The panel's on-select
  // empty-state stays as defense in depth. D3 (KPI) will hang off this router too.
  router.get('/chartable-cubes', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json({ cubes: await chartableCubes.list() });
    } catch (err) {
      return next(toIrisError(err, { op: 'list chartable cubes' }));
    }
  });

  // KPI discovery for the source picker (D3) — the KPI analogue of /chartable-cubes,
  // filtered through the same source-agnostic seam so the picker cannot drift.
  router.get('/kpis', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json({ kpis: toChartableKpis(await iris.kpi.list()) });
    } catch (err) {
      return next(toIrisError(err, { op: 'list chartable KPIs' }));
    }
  });

  // Richer KPI rendering (Track B): thresholds as a visual + issue counts, one envelope.
  // Under LOCAL_API_PREFIXES already (same /api/dashboard prefix) — no iris-proxy change.
  // Only a missing KPI escapes the reader (NotFoundError → 404 via toIrisError); a broken
  // value/issues read degrades inside a 200 (B-8).
  router.get('/kpi-health/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json(await kpiHealthReader.health(String(req.params.name)));
    } catch (err) {
      return next(toIrisError(err, { op: 'kpi health' }));
    }
  });

  // Layer 0 metadata for the builder UI.
  router.get('/cube-shape/:cube', async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json(await shapeReader.shape(String(req.params.cube)));
    } catch (err) {
      return next(toIrisError(err, { op: 'cube shape' }));
    }
  });

  // Lazy filter-member values for the builder's filter picker (B-CUBE-08). One MEMBERS read per
  // (cube, dimension, level) when a filter is added — not bundled into the cheap shape read. The
  // optional ?level= (B-CUBE-15) targets a specific level; absent → the dimension's first level.
  router.get('/cube-members/:cube/:dimension', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const level = typeof req.query.level === 'string' ? req.query.level : undefined;
      const members = await memberReader.members(String(req.params.cube), String(req.params.dimension), level);
      return res.json({ members });
    } catch (err) {
      return next(toIrisError(err, { op: 'cube members' }));
    }
  });

  // Layer 0 data: dispatch by source (cube / kpi).
  router.post('/chart-data', async (req: Request, res: Response, next: NextFunction) => {
    const b = req.body ?? {};
    try {
      let data;
      if (b.source === 'cube') {
        if (typeof b.cube !== 'string' || !Array.isArray(b.measures) || !b.measures.length) {
          throw new ValidationError('chart-data requires { cube, measures[] }.');
        }
        data = await cubeRunner.query({ cube: b.cube, measures: b.measures, dimensions: b.dimensions, topN: b.topN });
      } else if (b.source === 'kpi') {
        if (typeof b.kpi !== 'string' || !b.kpi) {
          throw new ValidationError('chart-data requires { kpi } for a KPI source.');
        }
        data = await kpiReader.values({ kpi: b.kpi, expandDimension: b.expandDimension });
      } else {
        throw new ValidationError(`Unsupported chart source '${b.source}'. Use 'cube' or 'kpi'.`);
      }
      // applicableTypes rides alongside so the builder offers only truthful types for THIS
      // shape (a scalar KPI → gauge only; an expanded KPI → cartesian/pie) — same source of truth.
      return res.json({ ...data, applicableTypes: capabilityFor(data) });
    } catch (err) {
      if (err instanceof ValidationError) return next(err);
      return next(toIrisError(err, { op: 'chart data' }));
    }
  });

  // Layers 1a/1b/2: pure presentation over the client-held ChartData. useAi is the
  // Layer-2 AI ceiling (fallback-invariant: an AI failure returns a 1b spec, not an
  // error). An explicit `type` is Layer 1a; no type is the deterministic Layer 1b.
  router.post('/chart-spec', async (req: Request, res: Response, next: NextFunction) => {
    const chartData = req.body?.chartData as ChartData | undefined;
    const type = req.body?.type as ChartType | undefined;
    if (!chartData || !Array.isArray(chartData.series)) {
      return next(new ValidationError('chart-spec requires a `chartData` body.'));
    }
    const funnelSort = req.body?.funnelSort === 'value' || req.body?.funnelSort === 'source' ? req.body.funnelSort : undefined;
    const opts = funnelSort ? { funnelSort } : undefined;
    // Highcharts is gone (round 5): the app renders on ECharts alone. There is no renderer
    // to negotiate — the route builds the spec directly on the one builder. `fallback`/`reason`
    // survive on the response, but sourced ONLY from the AI advisor (a non-AI response never
    // fell back — echarts supports every type — so it carries neither).
    try {
      // The deterministic recommendation rides EVERY response as `recommendedType`, so the
      // FE "Recommended" option can name what it would draw ("Recommended (Stacked Column)")
      // even while an explicit override or AI pick is shown. Single source of truth: the
      // advisor is backend-only, so the FE never re-derives (and never drifts from) the matrix.
      const recommendedType = recommend(chartData).type;
      if (req.body?.useAi === true) {
        const advisor = new LlmAuditAdvisor(env);
        const advice = await advisor.advise(chartData, req.body?.intent);
        const spec = echartsBuilder.build(chartData, advice.type, opts);
        // `fallback`/`reason`/`unavailable` are the AI advisor's own signals: the FE
        // circuit breaker greys "Ask AI" on `unavailable` (an outage) and shows the
        // fallback note on `fallback` (the model answered unusably).
        return res.json({ spec, type: advice.type, layer: '2', fallback: advice.fallback, reason: advice.reason, unavailable: advice.unavailable, recommendedType });
      }
      if (type) {
        return res.json({ spec: echartsBuilder.build(chartData, type, opts), type, layer: '1a', recommendedType });
      }
      const rec = recommend(chartData);
      return res.json({ spec: echartsBuilder.build(chartData, rec.type, opts), type: rec.type, layer: '1b', source: rec.source, intent: rec.intent, recommendedType });
    } catch (err) {
      if (err instanceof BuilderRejection) return next(new ValidationError(err.message));
      return next(toIrisError(err, { op: 'chart spec' }));
    }
  });

  // --- Load the saved dashboard (pure read: never writes back — spec §3 DA-SPEC-06) ---
  router.get('/layout', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = dashboards.get(DEFAULT_ID);
      // A missing row, a corrupt blob (rec.config already fell back to empty in the
      // repo), or a version this build can't read → render an empty config. We
      // deliberately do NOT persist it: an old build opening a newer/intact blob
      // must not overwrite it. Only PUT mutates the row.
      let config = rec?.config ?? emptyDashboardConfig();
      try { config = validateDashboardConfig(config); }
      catch { config = emptyDashboardConfig(); } // unknown-version / malformed → safe empty, no write
      return res.json({ config });
    } catch (err) {
      return next(err);
    }
  });

  // --- Save the dashboard (the ONLY route that mutates the row) ---
  router.put('/layout', (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = validateDashboardConfig(req.body?.config); // throws ValidationError → typed 400
      const rec = dashboards.upsert(DEFAULT_ID, DEFAULT_NAME, config);
      return res.json({ ok: true, updatedAt: rec.updatedAt });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
