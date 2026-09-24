import { describe, it, expect, vi } from 'vitest';
import { KpiHealthReader } from '../../src/dashboard/kpi-health.js';
import { NotFoundError } from '../../src/iris/iris-error.js';
import type { KpiDefinition } from '../../src/kpi/kpi-definition.model.js';
import type { RawKpiValuesResult } from '../../src/iris/kpi-value-client.js';
import type { IssuesReader } from '../../src/dashboard/kpi-issues.js';

const okScalar = (v: number | string | null): RawKpiValuesResult => ({ status: 200, body: { values: [{ label: 'k', value: v as number | null }] } });
const err500: RawKpiValuesResult = { status: 500, body: { Status: 'Error', Message: 'ERROR #5001' } };
const proto: RawKpiValuesResult = { status: 502, body: {} };

const defs = (def: KpiDefinition | null) => ({ get: vi.fn(async () => def) });
const values = (r: RawKpiValuesResult) => ({ values: vi.fn(async () => r) });
const issues = (data: Awaited<ReturnType<IssuesReader['summarize']>> | Error): IssuesReader => ({
  summarize: vi.fn(async () => { if (data instanceof Error) throw data; return data; }),
});
const noIssues: IssuesReader = { summarize: vi.fn(async () => ({ total: 0, bySeverity: [] })) };

const lowerBetter: KpiDefinition = { name: 'Late', label: 'Late Orders', watchingThreshold: 5, warningThreshold: 10 };

describe('KpiHealthReader.health', () => {
  it('two thresholds + a value in the watching band → threshold bands, coloured, status watching', async () => {
    const r = new KpiHealthReader(defs(lowerBetter), values(okScalar(7)), noIssues);
    const h = await r.health('Late');
    expect(h.value).toBe(7);
    expect(h.threshold!.target).toBe(5);
    expect(h.threshold!.bands).toEqual([
      { to: 5, kind: 'ok', color: '#009E73' },
      { to: 10, kind: 'watching', color: '#E69F00' },
      { to: null, kind: 'warning', color: '#D55E00' }, // Infinity → null on the wire
    ]);
    expect(h.threshold!.status).toBe('watching');
    expect(h.threshold!.statusColor).toBe('#E69F00');
    expect(h.issues).toBeNull(); // not an issueKpi
  });

  it('coerces a non-numeric value string to a number (review #3)', async () => {
    const r = new KpiHealthReader(defs(lowerBetter), values(okScalar('7')), noIssues);
    expect((await r.health('Late')).value).toBe(7);
  });

  it('a legitimately-empty value (null) stays null, status null, threshold still present', async () => {
    const r = new KpiHealthReader(defs(lowerBetter), values(okScalar(null)), noIssues);
    const h = await r.health('Late');
    expect(h.value).toBeNull();
    expect(h.valueUnavailable).toBeUndefined();
    expect(h.threshold).not.toBeNull();
    expect(h.threshold!.status).toBeNull();
  });

  it.each([['query (SC-2643 500)', err500], ['http/protocol', proto]] as const)(
    'a %s value error → value null + valueUnavailable, threshold STILL present, does NOT throw (Blocking #1)',
    async (_label, raw) => {
      const r = new KpiHealthReader(defs(lowerBetter), values(raw), noIssues);
      const h = await r.health('Late');
      expect(h.value).toBeNull();
      expect(h.valueUnavailable).toBe(true);
      expect(h.threshold).not.toBeNull();      // derived from the DEFINITION, survives the value failure
      expect(h.threshold!.status).toBeNull();
    },
  );

  it('indeterminate polarity (one threshold) → threshold null', async () => {
    const r = new KpiHealthReader(defs({ name: 'K', watchingThreshold: 5 }), values(okScalar(7)), noIssues);
    expect((await r.health('K')).threshold).toBeNull();
  });

  it('issueKpi + baseObject → issues summary', async () => {
    const def: KpiDefinition = { ...lowerBetter, issueKpi: true, baseObject: 'ProductInventory' };
    const r = new KpiHealthReader(defs(def), values(okScalar(7)), issues({ total: 3, bySeverity: [{ severity: 2, count: 3 }] }));
    expect((await r.health('Late')).issues).toEqual({ baseObject: 'ProductInventory', total: 3, bySeverity: [{ severity: 2, count: 3 }] });
  });

  it('issueKpi but NO baseObject → issues null (nothing to link on)', async () => {
    const def: KpiDefinition = { ...lowerBetter, issueKpi: true };
    const r = new KpiHealthReader(defs(def), values(okScalar(7)), noIssues);
    expect((await r.health('Late')).issues).toBeNull();
  });

  it('an issues-read failure degrades to { baseObject, unavailable } — never fails the health read (B-8)', async () => {
    const def: KpiDefinition = { ...lowerBetter, issueKpi: true, baseObject: 'ProductInventory' };
    const r = new KpiHealthReader(defs(def), values(okScalar(7)), issues(new Error('issues down')));
    expect((await r.health('Late')).issues).toEqual({ baseObject: 'ProductInventory', unavailable: true });
  });

  it('a missing KPI (def read → null) throws NotFoundError — the only throw', async () => {
    const r = new KpiHealthReader(defs(null), values(okScalar(7)), noIssues);
    await expect(r.health('Ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads the definition EXACTLY ONCE (B-12)', async () => {
    const d = defs(lowerBetter);
    await new KpiHealthReader(d, values(okScalar(7)), noIssues).health('Late');
    expect(d.get).toHaveBeenCalledTimes(1);
  });

  it('runs the value read and the issues read CONCURRENTLY (issues is not gated on values resolving)', async () => {
    const def: KpiDefinition = { ...lowerBetter, issueKpi: true, baseObject: 'ProductInventory' };
    let releaseValues!: (r: RawKpiValuesResult) => void;
    const gate = new Promise<RawKpiValuesResult>((res) => { releaseValues = res; });
    const valuesFn = vi.fn(() => gate);              // never resolves until we release it
    const issuesFn = vi.fn(async () => ({ total: 1, bySeverity: [{ severity: 2, count: 1 }] }));
    const reader = new KpiHealthReader(defs(def), { values: valuesFn }, { summarize: issuesFn });

    const p = reader.health('Late');                 // kicks off both reads
    await Promise.resolve();                          // let the synchronous kickoff settle
    // In the SERIAL (old) code, summarize is only reached AFTER values resolves — so with values gated
    // it would be uncalled here. Concurrent code calls it immediately.
    expect(issuesFn).toHaveBeenCalledTimes(1);

    releaseValues(okScalar(7));
    const h = await p;
    expect(h.value).toBe(7);
    expect(h.issues).toEqual({ baseObject: 'ProductInventory', total: 1, bySeverity: [{ severity: 2, count: 1 }] });
  });
});
