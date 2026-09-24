/**
 * SC-2701 spike probe: can a cross-measure / cross-date COMPARISON be authored as
 * an MDX KPI CONDITION (a query-time slicer string) instead of a pre-computed cube
 * dimension whose members encode the result (the `rangeExpression` convention —
 * `backend/.claude/skills/cube/references/cube-definition.md` Examples 1 & 3)?
 *
 * This file is the SPIKE INSTRUMENT, not a shipped feature. Each `it` POSTs a raw
 * comparison string as a `kpiConditions` entry and records the engine's verdict on
 * BOTH read paths, then asserts the accept/reject DISTINCTION (never merely "no
 * throw" — a mutant that treated a 500 as success must redden):
 *
 *   accept  = HTTP 200 + a finite number         (a real, filtered slice)
 *   reject  = product path  POST /api/dashboard/chart-data  → HTTP 422 QUERY_FAILED
 *             raw engine    GET  /api/scbi/v1/kpi/values/{n} → HTTP 500 + an IRIS error
 *                                                              carrying a `#NNNN` code  (SC-2643)
 *
 * The raw endpoint is captured too because its `#NNNN` code is the richest evidence
 * of WHY a construct rejects (the product path maps every query failure to a
 * cause-agnostic 422). LOCALE NOTE: this instance emits IRIS status text in ARABIC —
 * `خطأ #5002` = "Error #5002" — so the reject assertions match the locale-independent
 * `#\d+` code, NOT the English word "ERROR". Both paths verified:
 *   - chart-data → KpiValueReader → classifyKpiValue → QueryError(httpStatus 422)
 *     (kpi-values.ts, iris-error.ts, error-middleware.ts).
 *   - values/{n} is proxied straight to IRIS (scbi ∉ LOCAL_API_PREFIXES), so the raw
 *     500 surfaces verbatim (sc-kpi-values-contract-verified; the reject path is
 *     INDEPENDENTLY proven by the existing kpi-invalid KI7 test).
 *
 * REJECT ENVELOPE, re-verified 2026-09-10: the raw 500 body is the %Status/Atelier
 * shape `{ errors:[{ code:5002, error:"…#5002 … <INVALID OREF>…" }], summary }`, NOT
 * the `{ Status:"Error", Message }` shape recorded on 2026-08-23. Every un-evaluatable
 * condition — P4, P5, a non-MDX string, even a blank one — reports the same
 * `#5002 <INVALID OREF>ConstructKpiValueResponse`. `classifyKpiValue` recognized only
 * the older shape, so the product path answered 502 SCO_HTTP (a GATEWAY fault) for
 * what is the author's own bad query; it now matches both shapes and answers 422. That
 * fix is what P4/P5/P6b assert through the product path.
 *
 * THE HEADLINE FINDING (verified live 2026-09-09, wb-sco-v3): a KPI condition is
 * emitted by the engine as `WHERE (<string>)`. In that slicer, an explicit member
 * SET `{a,b}` AGGREGATES correctly (P7 → 1725), but a `FILTER(members,cmp)` is read
 * as a TUPLE and SILENTLY COLLAPSES to a single (last) member — so a threshold /
 * cross-measure comparison written as `FILTER(...)` is ACCEPTED (200) yet returns a
 * WRONG number with NO error to catch (P1/P2 → 1095, not the correct 1725). That
 * silent-wrong-number is WORSE than a reject. `WITH MEMBER` (P4) and `IIF`-as-member
 * (P5) both REJECT — as #5002 <INVALID OREF> on this instance, not the #5001 recorded
 * earlier. See the finding doc for the full verdict + recommendation.
 *
 * HARVEST: every probe records its exact request string + both-path status/value
 * into a module matrix BEFORE asserting, and afterAll prints the whole table, so the
 * verdict matrix — the actual deliverable data — is copy-pasteable from the run log
 * even if an assertion reddens.
 *
 * The value assertions are pinned to the deterministic seed (provision.ts
 * `sourceClass().Seed()`): RegionD Total → North 630, South 480, East 1095;
 * unfiltered baseline 2205; sourced COUNT `Cnt` → North 5, South 5, East 10. Each
 * accept probe asserts the exact number so a change reddens loudly with the actual
 * value; each "silently wrong" probe asserts it is NOT the correct aggregate (so a
 * future engine fix that made FILTER aggregate correctly would redden — flagging the
 * finding is stale — exactly as KI7 pins current buggy behavior). The baseline (P0, a
 * known accept) and a NON-MDX string (P6b, a guaranteed reject) BRACKET the harness: if
 * P0 can't see an accept or P6b can't see a reject, the instrument is broken, not the
 * construct. P6b holds that role because the cross-dimension tuple that used to (P6)
 * turned out to be a correctly-evaluated ACCEPT — see P6's own note.
 *
 * Live IRIS required; run via: npm run test:it  (harness: ./wb it wt-b).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import {
  seedSource,
  buildTestCube,
  runCleanups,
  uniqueSuffix,
  TEST_CUBE_MEASURE,
  REGION_DIMENSION,
  type Cleanup,
  type BuiltCube,
} from './helpers/provision.js';
import { sweep, healCubeRegistry } from './helpers/sweep.js';
import type { CubeMeasure, CubeDimension } from '../../src/cube/cube-definition.model.js';
import type { ChartData } from '../../src/dashboard/chart-data.js';
import { irisErrorText, type RawKpiValuesBody } from '../../src/iris/kpi-value-client.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

// ── Cube shape for the probe ─────────────────────────────────────────────────
// The shared minimal cube is RegionD + a single SUM measure `Total`. The probe
// needs a SECOND measure (for the cross-measure comparison) and a SECOND dimension
// (for the cross-dimension tuple probe, P6), so it overrides both arrays
// (buildTestCube REPLACES, it does not merge). Fact numbers: RegionD.Region=2
// (REGION_DIMENSION), ProductD.Product=5 — unique + ≥2 (validateCubeDefinition needs
// only that; not contiguity). Measure factName/factNumber are NOT emitted (the
// generator auto-assigns fact storage), so their values are cosmetic here.
const REGION_LEVEL = '[RegionD].[H1].[Region]';

/** SUM(Amount) — the KPI's aggregated measure. Byte-mirrors provision.minimalCubeDef's. */
const TOTAL_MEASURE: CubeMeasure = {
  name: 'Total', sourceProperty: 'Amount', factName: 'MxTotal', aggregate: 'SUM', type: 'number', factNumber: 3,
};
/** COUNT of source rows per member. MUST be SOURCED (sourceProperty Amount) — a
 *  SOURCELESS COUNT measure compiles (cube-generator.ts:338-339 coerces it to COUNT)
 *  but reads 0 everywhere on this engine, which would make the cross-measure probe
 *  meaningless. Sourced COUNT reads per region: North 5, South 5, East 10. Used for
 *  the cross-MEASURE comparison `[Total] > [Cnt]*100`. */
const CNT_MEASURE: CubeMeasure = {
  name: 'Cnt', sourceProperty: 'Amount', factName: 'MxCnt', aggregate: 'COUNT', type: 'integer', factNumber: 4,
};
/** A second data dimension over the source's `Product` property — only present so the
 *  cross-dimension tuple probe (P6) has two dimensions to form a tuple across. */
const PRODUCT_DIMENSION: CubeDimension = {
  name: 'ProductD', type: 'data', hasAll: true,
  hierarchies: [{ name: 'H1', levels: [{ name: 'Product', sourceProperty: 'Product', factNumber: 5 }] }],
};

/** Seed-derived expected KPI values (raw SUM of Total over the sliced members). */
const BASELINE = 2205;          // unfiltered total (North 630 + South 480 + East 1095)
const NORTH = 630;              // Region North; ALSO Product Widget — the seed pairs them 1:1 (P6)
const GADGET = 480;             // Product Gadget; ALSO Region South, same 1:1 pairing (P6)
const EAST = 1095;              // Total > 1000 selects East only; ALSO the value FILTER collapses to
const NORTH_PLUS_EAST = 1725;   // the CORRECT aggregate of {North(630),East(1095)} — Total>600 and Total>Cnt*100
const SOUTH = 480;             // Total < 600 / <= 500 selects South only (complement of {North,East})

/** One harvested row of the verdict matrix — recorded BEFORE any assertion so a red never loses it. */
interface MatrixRow {
  label: string;
  cond: string;
  chart: { status: number; value: number | null | undefined };
  raw: { status: number; message?: string; value?: number | null };
}
const matrix: MatrixRow[] = [];

d('SC-2701 comparison-as-MDX-condition spike (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(async () => {
    app = bootApp();
    await healCubeRegistry(app.iris);
  });
  afterAll(async () => {
    await sweep(app.iris);
    await app.close();
    // The harvest: print the whole verdict matrix so it is copy-pasteable into the finding
    // doc regardless of which probes reddened. Format: request string, then both-path outcome.
    const fmt = (v: number | null | undefined) => (v === undefined ? '—' : v === null ? 'null' : String(v));
    const lines = ['', '=== SC-2701 comparison-as-MDX-condition verdict matrix ==='];
    for (const r of matrix) {
      lines.push(`${r.label}`);
      lines.push(`    cond : ${r.cond || '(none — baseline)'}`);
      lines.push(
        `    chart-data=${r.chart.status} value=${fmt(r.chart.value)}   raw=${r.raw.status}${r.raw.message ? ` ${r.raw.message.slice(0, 120)}` : ''}`,
      );
    }
    lines.push('=========================================================');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  });
  beforeEach(() => {
    cleanups = [];
  });
  afterEach(async () => {
    await runCleanups(cleanups);
  });

  /** Build the source + comparison cube (RegionD + ProductD + Total + Cnt); register cleanups. */
  async function comparisonCube(): Promise<BuiltCube> {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const cube = await buildTestCube(app.iris, src, {
      dimensions: [structuredClone(REGION_DIMENSION), PRODUCT_DIMENSION],
      measures: [TOTAL_MEASURE, CNT_MEASURE],
    });
    cleanups.push(cube.cleanup);
    return cube;
  }

  /**
   * Create a raw KPI carrying `kpiConditions` over `cube`, read its scalar value on BOTH paths,
   * record the exchange into the matrix (so the harvest survives an assertion failure), and
   * return it WITHOUT asserting status — a reject is an expected outcome to record, not a throw.
   * CREATE itself is asserted 200/201: the whole path is an opaque `string[]` pass-through (zod is
   * bare `z.array(z.string())`, no pattern), so a comparison string is always STORED — the verdict
   * is deferred to value-read. That deferral (create-accepts, read-decides) is itself a finding.
   */
  async function probe(label: string, cube: BuiltCube, kpiConditions: string[]): Promise<MatrixRow> {
    const name = `WorkbenchTestKpi${uniqueSuffix()}`;
    cleanups.push(() => app.iris.kpi.delete(name).catch(() => {}));
    const created = await postJson(app.base, '/api/scbi/v1/kpi/definitions', {
      name, label: 'SC-2701 probe', type: 'DeepSee', status: 'Active',
      deepseeKpiSpec: { namespace: 'SC', cube: cube.cubeName, kpiMeasure: TEST_CUBE_MEASURE, valueType: 'raw', kpiConditions },
    });
    expect([200, 201], `CREATE is opaque; a comparison string must always store. body=${await bodyText(created.res.clone())}`)
      .toContain(created.status);

    // Product path (what the app actually does): 200 + number, or 422 QUERY_FAILED.
    const chartRes = await fetch(`${app.base}/api/dashboard/chart-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kpi', kpi: name }),
    });
    let value: number | null | undefined;
    if (chartRes.status === 200) {
      const data = await jsonOf<ChartData>(chartRes);
      value = data.series[0]?.data.find((v): v is number => typeof v === 'number');
    }

    // Raw engine verdict (richest evidence — carries the #NNNN code on reject).
    const rawRes = await fetch(`${app.base}/api/scbi/v1/kpi/values/${name}`);
    const rawBody = await jsonOf<RawKpiValuesBody>(rawRes);
    const row: MatrixRow = {
      label,
      cond: kpiConditions.join(' AND '),
      chart: { status: chartRes.status, value },
      // The error text via the PRODUCT's own extraction, not `rawBody.Message` — the live
      // envelope is `{ errors:[], summary }`, so reading Message harvested `undefined` and the
      // `#NNNN` evidence this instrument exists to collect was silently lost.
      raw: { status: rawRes.status, message: irisErrorText(rawBody), value: rawBody.values?.find((v) => typeof v.value === 'number')?.value },
    };
    matrix.push(row);   // record BEFORE the caller asserts, so a red keeps the harvested row
    return row;
  }

  // ── P0: baseline control — a KNOWN ACCEPT that proves the cube+harness can read a value.
  it('P0 (control): no condition reads the unfiltered baseline — the anchor every probe compares against', async () => {
    const cube = await comparisonCube();
    const r = await probe('P0 baseline (no condition)', cube, []);
    expect(r.chart.status, `baseline must read cleanly (else the cube/process is unhealthy and no reject below is attributable to a construct). raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value).toBe(BASELINE);
    expect(r.raw.status).toBe(200);
  });

  // ── P1: aggregate threshold FILTER over a MULTI-member set — the primary "comparison as a
  //        condition" candidate, AND the discriminator that exposes the tuple-collapse bug.
  it('P1 (SILENTLY WRONG): FILTER(members,[Total]>600) is ACCEPTED but collapses to one member — reads 1095, not the correct 1725', async () => {
    const cube = await comparisonCube();
    // Total>600 selects {North(630),East(1095)} → correct aggregate 1725. But a bare FILTER in the
    // WHERE-slicer is read as a TUPLE and collapses to a single (last) member → East(1095). The
    // engine returns 200 with a WRONG number and NO error — the headline finding. Assert:
    //   • ACCEPTED (200) — no reject to warn the author, and
    //   • value ≠ 1725 — it is NOT the correct multi-member aggregate (the silent-wrong-number),
    //   • value ≠ 2205 — it IS filtered to *something* (not a silent no-op / full baseline).
    // A future engine fix that made FILTER aggregate correctly would flip value→1725 and redden
    // THIS assertion, flagging the finding as stale (KI7 pattern).
    const cond = `FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>600)`;
    const r = await probe('P1 FILTER threshold ([Total]>600, multi-member)', cube, [cond]);
    expect(r.chart.status, `FILTER-by-threshold is ACCEPTED (200) despite being wrong; raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, `SILENT COLLAPSE: FILTER(>600) should aggregate {North,East}=1725 but returns one member`).not.toBe(NORTH_PLUS_EAST);
    expect(r.chart.value, 'genuinely sliced (not a silent no-op reading the full baseline)').not.toBe(BASELINE);
    expect(r.chart.value, 'observed collapse value is East (1095) — the last qualifying member').toBe(EAST);
    expect(r.raw.status).toBe(200);
  });

  // ── P2: cross-MEASURE comparison — the construct the ticket names most directly. Same collapse.
  it('P2 (SILENTLY WRONG): FILTER(members,[Total]>[Cnt]*100) — a cross-measure comparison — is ACCEPTED but collapses (1095, not 1725)', async () => {
    const cube = await comparisonCube();
    // Compares two measures per member: North 630>500 ✓, South 480>500 ✗, East 1095>1000 ✓ →
    // correct {North,East}=1725. Same WHERE-slicer tuple-collapse as P1 → returns East(1095).
    const cond = `FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>[Measures].[Cnt]*100)`;
    const r = await probe('P2 cross-measure FILTER ([Total]>[Cnt]*100)', cube, [cond]);
    expect(r.chart.status, `cross-measure FILTER is ACCEPTED (200) despite being wrong; raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, `SILENT COLLAPSE: should aggregate {North(630),East(1095)}=1725; South(480) excluded`).not.toBe(NORTH_PLUS_EAST);
    expect(r.chart.value, 'genuinely sliced, not the full baseline').not.toBe(BASELINE);
    expect(r.chart.value, 'observed collapse value is East (1095)').toBe(EAST);
    expect(r.raw.status).toBe(200);
  });

  // ── P3: empty-result FILTER — the trap that must NOT read as the unfiltered total.
  it('P3 (correctness guard): FILTER(members,[Total]<0) selects nothing — must NOT silently read the baseline', async () => {
    const cube = await comparisonCube();
    const cond = `FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]<0)`;
    const r = await probe('P3 empty FILTER ([Total]<0)', cube, [cond]);
    // An empty comparison is EITHER an empty/zero slice (200 + 0/empty/null) OR an "empty WHERE
    // clause" reject (#5001, SC-2643 family). Both acceptable; a comparison matching no members
    // that read the FULL total (empty filter treated as no filter) would be the dangerous defect.
    if (r.chart.status === 200) {
      expect(r.chart.value ?? 0, 'empty comparison must be 0/empty, never the unfiltered total').not.toBe(BASELINE);
    } else {
      expect(r.chart.status, 'if not 200, an empty comparison rejects as a query error').toBe(422);
      expect(r.raw.status).toBe(500);
    }
  });

  // ── P4: WITH MEMBER calculated member — probes whether a condition slot honours a WITH clause.
  it('P4 (REJECT): a WITH MEMBER calculated-member fragment is not a slicer element — rejects (#NNNN)', async () => {
    const cube = await comparisonCube();
    // The codebase's only calc-member-in-MDX precedent (cube-query.ts) prefixes a WITH clause on the
    // full SELECT statement — NOT the KPI-condition path. A KPI condition is a slicer element, so a
    // bare `WITH MEMBER … AS …` string has no statement to attach to → REJECT (syntax/wrong-context).
    const cond = `WITH MEMBER [Measures].[Late] AS 'IIF([Measures].[Total]>[Measures].[Cnt]*100,1,0)'`;
    const r = await probe('P4 WITH MEMBER calc-member fragment', cube, [cond]);
    expect(r.chart.status, `WITH MEMBER fragment expected REJECT (422); got ${r.chart.status} value=${r.chart.value}`).toBe(422);
    expect(r.raw.status, 'raw engine rejects with a 500 + #NNNN (SC-2643 family)').toBe(500);
    expect(r.raw.message, 'the #NNNN code is the evidence of WHY it rejected (locale-independent)').toMatch(/#\d+/);
  });

  // ── P5: IIF returning a member — REJECTS (#5001 "measures cannot exist on multiple axes"): the
  //        IIF references [Measures].[Total] in the slicer while the KPI puts its kpiMeasure on an
  //        axis → the same measure on two axes. So IIF-as-member cannot classify per-member at all.
  it('P5 (REJECT): IIF(measure-cmp, memberA, memberB) puts a measure on two axes — rejects (#NNNN)', async () => {
    const cube = await comparisonCube();
    const cond = `IIF([Measures].[Total]>500,${REGION_LEVEL}.&[North],${REGION_LEVEL}.&[South])`;
    const r = await probe('P5 IIF-as-member (measure-in-slicer)', cube, [cond]);
    expect(r.chart.status, `IIF-as-member expected REJECT (422); got ${r.chart.status} value=${r.chart.value}; raw #=${r.raw.message}`).toBe(422);
    expect(r.raw.status).toBe(500);
    expect(r.raw.message, 'the #NNNN code (observed #5001, "measures cannot exist on multiple axes")').toMatch(/#\d+/);
  });

  // ── P6: a cross-dimension tuple. This probe was written as the "known reject" negative
  //        control, on the strength of an earlier 422 observation. RE-PROBED 2026-09-10 on this
  //        instance, that premise is FALSE: the tuple is accepted AND evaluated correctly, so
  //        it cannot serve as a reject control. The seed makes the proof exact — Region and
  //        Product are assigned from the same `(i#4)+1` index, so North rows ARE the Widget
  //        rows: (North,Widget) intersects to all of North (630) while (North,Gadget)
  //        intersects to nothing (0). Both were measured. A tuple that had COLLAPSED to one
  //        member (the P1/P2 defect) would have read 630 for BOTH, so the disjoint case is what
  //        distinguishes "correct intersection" from "silent collapse" — which is why it is
  //        asserted here rather than just the coincident one.
  //        The reject-detection duty this probe used to carry moved to P6b below.
  it('P6 (ACCEPT, correct): a cross-dimension tuple INTERSECTS correctly — it is valid MDX, not a reject', async () => {
    const cube = await comparisonCube();
    // Coincident members: North ∩ Widget = every North row = 630 (== North alone).
    const coincident = `(${REGION_LEVEL}.&[North],[ProductD].[H1].[Product].&[Widget])`;
    const rc = await probe('P6 cross-dimension tuple (North,Widget) — coincident', cube, [coincident]);
    expect(rc.chart.status, `a cross-dimension tuple is ACCEPTED; raw #=${rc.raw.message}`).toBe(200);
    expect(rc.chart.value, 'North ∩ Widget is all of North (the seed pairs them 1:1) = 630').toBe(NORTH);
    expect(rc.raw.status).toBe(200);

    // Disjoint members: North ∩ Gadget = no rows = 0. THIS is the discriminator — a slicer
    // that collapsed the tuple to a single member would read 630 (North) or 480 (Gadget).
    const disjoint = `(${REGION_LEVEL}.&[North],[ProductD].[H1].[Product].&[Gadget])`;
    const rd = await probe('P6 cross-dimension tuple (North,Gadget) — disjoint', cube, [disjoint]);
    expect(rd.chart.status, `the disjoint tuple is also ACCEPTED; raw #=${rd.raw.message}`).toBe(200);
    expect(rd.chart.value ?? 0, 'North ∩ Gadget is empty = 0 — proof the tuple INTERSECTS rather than collapsing').toBe(0);
    expect(rd.chart.value, 'not collapsed to the Region member').not.toBe(NORTH);
    expect(rd.chart.value, 'not collapsed to the Product member').not.toBe(GADGET);
  });

  // ── P6b: the real negative control. P6 turned out to be an accept, which left the suite with
  //        no probe proving it can SEE a reject — and without that, every ACCEPT above is
  //        unfalsifiable (a harness that reported 200 for everything would pass them all).
  //        A string that is not MDX at all is the strongest possible reject: there is no engine
  //        behaviour under which it should evaluate. Verified live to produce the same
  //        #5002 <INVALID OREF> as P4/P5, on both paths.
  it('P6b (negative control): a non-MDX condition rejects — proves the probe distinguishes reject from accept', async () => {
    const cube = await comparisonCube();
    const cond = `))) not mdx at all (((`;
    const r = await probe('P6b non-MDX gibberish (reject control)', cube, [cond]);
    expect(r.chart.status, `gibberish MUST reject (422); if this is 200 the harness cannot detect rejects and every ACCEPT above is suspect. raw #=${r.raw.message}`).toBe(422);
    expect(r.raw.status).toBe(500);
    expect(r.raw.message).toMatch(/#\d+/);
  });

  // ── P7: explicit member SET control — the SAME intent as P1 written as `{North,East}` instead of
  //        FILTER. This is exactly what composeCondition already emits for `isOneOf`. It AGGREGATES
  //        correctly (1725), proving the WHERE-slicer CAN sum a multi-member set — so the P1/P2 wrong
  //        number is a FILTER-coercion defect, NOT a "slicer can't aggregate" limitation.
  it('P7 (ACCEPT, correct): an explicit {North,East} set aggregates to 1725 — isolates the defect to FILTER', async () => {
    const cube = await comparisonCube();
    const cond = `{${REGION_LEVEL}.&[North],${REGION_LEVEL}.&[East]}`;
    const r = await probe('P7 explicit set {North,East} (control)', cube, [cond]);
    expect(r.chart.status, `an explicit member set is ACCEPTED (200); raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, 'a set slicer AGGREGATES: North(630)+East(1095)=1725 — the number FILTER should have returned').toBe(NORTH_PLUS_EAST);
    expect(r.raw.status).toBe(200);
  });

  // ── P8: AGGREGATE(FILTER(...)) — the candidate SAFE way to express an aggregate comparison as a
  //        condition. In raw MDX, WITH MEMBER AS AGGREGATE(FILTER(...)) sums correctly; does wrapping
  //        the FILTER in AGGREGATE inside the WHERE-slicer also fix the collapse? Record the verdict.
  it('P8 (workaround probe): AGGREGATE(FILTER(members,[Total]>600)) — does explicit aggregation fix the collapse?', async () => {
    const cube = await comparisonCube();
    const cond = `AGGREGATE(FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>600))`;
    const r = await probe('P8 AGGREGATE(FILTER([Total]>600))', cube, [cond]);
    // Exploratory: assert only that it is ACCEPTED and record the value. The finding doc states
    // whether it returned the correct 1725 (a viable workaround) or a wrong number (not viable).
    expect(r.chart.status, `AGGREGATE(FILTER(...)) status; raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, 'AGGREGATE(FILTER([Total]>600)) aggregates {North,East} correctly to 1725').toBe(NORTH_PLUS_EAST);
    expect(r.raw.status).toBe(200);
  });

  // ── P9: %OR(FILTER(...)) — the other wrapper tried in raw-MDX isolation. It fixed the >600 case
  //        there but was inconsistent across thresholds through the KPI path; record the verdict.
  it('P9 (workaround probe): %OR(FILTER(members,[Total]>600)) — an alternative wrapper', async () => {
    const cube = await comparisonCube();
    const cond = `%OR(FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>600))`;
    const r = await probe('P9 %OR(FILTER([Total]>600))', cube, [cond]);
    expect(r.chart.status, `%OR(FILTER(...)) status; raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, '%OR(FILTER([Total]>600)) aggregates {North,East} to 1725').toBe(NORTH_PLUS_EAST);
    expect(r.raw.status).toBe(200);
  });

  // ── P10–P13: the ACTUALLY-COMPOSED strings composeComparison emits (spec §6). These are the shapes
  //    the affordance ships; each must return the correct seed-derived aggregate on the unfixed engine.
  //    LITERAL MIRROR of composeComparison — pinned byte-for-byte by the FE comparison-mdx.spec.ts
  //    "RegionD it-cube literal mirror" block, which cannot be imported here (backend tsconfig excludes
  //    frontend/; the only verified cross-workspace direction is FE-spec → backend-src). A composer
  //    change reddens THAT FE spec; these literals are the fixed engine-truth pin.

  it('P10 (ACCEPT, correct): composed > emits AGGREGATE(FILTER(>600)) → 1725 (matches P8)', async () => {
    const cube = await comparisonCube();
    const cond = `AGGREGATE(FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>600))`;
    const r = await probe('P10 composed > ([Total]>600)', cube, [cond]);
    expect(r.chart.status, `raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, 'AGGREGATE(FILTER([Total]>600)) aggregates {North,East}=1725').toBe(NORTH_PLUS_EAST);
    expect(r.raw.status).toBe(200);
  });

  it('P11 (ACCEPT, correct): composed >= emits AGGREGATE(FILTER(>=630)) → 1725 (North 630 + East 1095; South 480 excluded)', async () => {
    const cube = await comparisonCube();
    const cond = `AGGREGATE(FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>=630))`;
    const r = await probe('P11 composed >= ([Total]>=630)', cube, [cond]);
    expect(r.chart.status, `raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, '>=630 selects {North(630),East(1095)}=1725').toBe(NORTH_PLUS_EAST);
    expect(r.raw.status).toBe(200);
  });

  it('P12 (ACCEPT, correct): composed < emits AGGREGATE(EXCEPT(...,FILTER(>=600))) → 480 (South only, complement of {North,East})', async () => {
    const cube = await comparisonCube();
    const cond = `AGGREGATE(EXCEPT(${REGION_LEVEL}.MEMBERS,FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>=600)))`;
    const r = await probe('P12 composed < ([Total]<600 via EXCEPT)', cube, [cond]);
    expect(r.chart.status, `raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, '< 600 = baseline − {Total>=600 = North,East} = South(480)').toBe(SOUTH);
    expect(r.raw.status).toBe(200);
  });

  it('P13 (ACCEPT, correct): composed <= emits AGGREGATE(EXCEPT(...,FILTER(>500))) → 480 (South only, complement of {North,East})', async () => {
    const cube = await comparisonCube();
    const cond = `AGGREGATE(EXCEPT(${REGION_LEVEL}.MEMBERS,FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]>500)))`;
    const r = await probe('P13 composed <= ([Total]<=500 via EXCEPT)', cube, [cond]);
    expect(r.chart.status, `raw #=${r.raw.message}`).toBe(200);
    expect(r.chart.value, '<= 500 = baseline − {Total>500 = North,East} = South(480)').toBe(SOUTH);
    expect(r.raw.status).toBe(200);
  });

  // ── P14–P15: the < direction's WRONG forms — the traps the composer must NEVER emit. Assert they do
  //    NOT return the correct 480, so a future SC-2703 fix that made them correct reddens and flags the
  //    finding stale (KI7 pattern), exactly like P1/P2.
  it('P14 (SILENTLY WRONG): bare FILTER([Total]<600) does NOT return the correct complement (480)', async () => {
    const cube = await comparisonCube();
    const cond = `FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]<600)`;
    const r = await probe('P14 bare FILTER([Total]<600) — MUST NOT be used', cube, [cond]);
    expect(r.chart.value, 'a bare FILTER in the < direction must NOT yield the correct 480 (tuple-collapse)').not.toBe(SOUTH);
  });

  it('P15 (SILENTLY WRONG): AGGREGATE(FILTER([Total]<600)) reads the baseline, NOT the complement (480)', async () => {
    const cube = await comparisonCube();
    const cond = `AGGREGATE(FILTER(${REGION_LEVEL}.MEMBERS,[Measures].[Total]<600))`;
    const r = await probe('P15 AGGREGATE(FILTER([Total]<600)) — the < trap', cube, [cond]);
    expect(r.chart.value, 'AGGREGATE(FILTER) for < silently reads the baseline, not South(480) — why the composer uses EXCEPT').not.toBe(SOUTH);
  });
});

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; res: Response }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, res };
}

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
