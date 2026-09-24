/**
 * Issue Management page data path against live SCO (SC-2702). Pure reads — nothing
 * to provision or clean up; the instance's own issues are the fixture.
 *
 * Two things this suite exists to pin, because guessing them wrong is invisible:
 *  - SCO's issue API is PAGED and clamps pageSize to 1000, so the list route must
 *    report the real total separately from the rows it returns.
 *  - SCO IGNORES query parameters it does not recognize, so a misspelled filter
 *    returns EVERY issue. The route's own vocabulary must be rejected before it
 *    reaches SCO; the last describe block documents the raw SCO behaviour.
 *
 * Live IRIS with SCO required; run via: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { SCO_MAX_PAGE_SIZE } from '../../src/iris/issue-rest-client.js';
import type { IssueCounts, IssueDetail, IssueRow } from '../../src/issues/issue-list.js';

interface ListBody {
  issues: IssueRow[];
  totalCount: number;
  truncated: boolean;
  cap: number;
}

describe('Issue Management data (live)', () => {
  let app: BootedApp;
  let counts: IssueCounts;

  beforeAll(async () => {
    app = bootApp();
    const res = await fetch(`${app.base}/api/issues/counts`);
    expect(res.status, await res.clone().text()).toBe(200);
    counts = (await jsonOf<{ counts: IssueCounts }>(res)).counts;
  });

  afterAll(async () => { await app.close(); });

  it('the nav counts cover every dimension in one request', () => {
    // Documents the live shape: an instance with sample data has KPI-triggered
    // issues and severities, and (until an analysis process runs) NO urgencies.
    console.log('[SC-2702] live issue counts:', JSON.stringify({
      total: counts.total,
      kpis: Object.keys(counts.byKpi).length,
      bySeverity: counts.bySeverity,
      workQueue: counts.workQueue,
    }));
    // Every dimension must come back in the one request, even at zero: CI runs
    // against a clean SCO that has no issues yet, so a count of 0 is valid data
    // and a MISSING band is the real defect. The rest of the suite reads actual
    // rows whenever the instance has them.
    expect(counts.bySeverity).toEqual({
      High: expect.any(Number),
      Medium: expect.any(Number),
      Low: expect.any(Number),
    });
    expect(counts.total).toEqual(expect.any(Number));
    expect(counts.workQueue).toEqual(expect.any(Number));
    expect(counts.byKpi).toEqual(expect.any(Object));
    const banded = counts.bySeverity.High + counts.bySeverity.Medium + counts.bySeverity.Low;
    // Severity may be unset on some issues, so the bands can only be <= total.
    expect(banded).toBeLessThanOrEqual(counts.total);
    expect(counts.workQueue).toBeLessThanOrEqual(counts.total);
  });

  it('a KPI category returns only that KPI’s issues, and the count matches the badge', async () => {
    const [kpi, badge] = Object.entries(counts.byKpi).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!kpi) return expect(Object.keys(counts.byKpi)).toEqual([]);
    const body = await jsonOf<ListBody>(
      await fetch(`${app.base}/api/issues?group=kpi&value=${encodeURIComponent(kpi)}`),
    );
    expect(body.totalCount).toBe(badge);
    expect(body.issues.every((i) => i.kpi === kpi)).toBe(true);
    // Never more than one SCO page, whatever the total.
    expect(body.issues.length).toBeLessThanOrEqual(SCO_MAX_PAGE_SIZE);
  });

  it('every severity badge agrees with the list SCO returns', async () => {
    // The badges come from SQL and the lists come from SCO's REST API, so they
    // only agree if the count query reads a NULL severity as absent rather than
    // as 0 (CAST(... AS VARCHAR) — an unset value must fall in NO band; SQL
    // hands a NULL integer back as 0).
    for (const band of ['High', 'Medium', 'Low'] as const) {
      const body = await jsonOf<ListBody>(
        await fetch(`${app.base}/api/issues?group=severity&value=${band}`),
      );
      expect(body.totalCount, band).toBe(counts.bySeverity[band]);
    }
  });

  it('a category larger than one SCO page is capped and says so', async () => {
    const oversized = Object.entries(counts.byKpi).find(([, n]) => n > SCO_MAX_PAGE_SIZE);
    const band = (['Medium', 'High', 'Low'] as const).find(
      (b) => counts.bySeverity[b] > SCO_MAX_PAGE_SIZE,
    );
    const url = oversized
      ? `/api/issues?group=kpi&value=${encodeURIComponent(oversized[0])}`
      : band
        ? `/api/issues?group=severity&value=${band}`
        : null;
    if (!url) {
      // Documents that this instance has no category above the cap; the cap path
      // is then covered by the unit tests only.
      console.log('[SC-2702] no category exceeds the page cap on this instance');
      return;
    }
    const body = await jsonOf<ListBody>(await fetch(`${app.base}${url}`));
    expect(body.issues).toHaveLength(SCO_MAX_PAGE_SIZE);
    expect(body.totalCount).toBeGreaterThan(SCO_MAX_PAGE_SIZE);
    expect(body.truncated).toBe(true);
  });

  it('a band with no matching issues is an empty 200, not an error', async () => {
    // severity 1 is unused on a clean instance, so the Low band is empty. The
    // page must render that rather than fail.
    const res = await fetch(`${app.base}/api/issues?group=severity&value=Low`);
    expect(res.status).toBe(200);
    const body = await jsonOf<ListBody>(res);
    expect(body.totalCount).toBe(counts.bySeverity.Low);
    expect(body.issues).toHaveLength(Math.min(body.totalCount, SCO_MAX_PAGE_SIZE));
  });

  it('the work queue only holds issues parked in a workflow', async () => {
    const body = await jsonOf<ListBody>(
      await fetch(`${app.base}/api/issues?group=workqueue&value=all`),
    );
    expect(body.totalCount).toBe(counts.workQueue);
    expect(body.issues.every((i) => i.status === 'Workflow')).toBe(true);
  });

  it('severity bands partition on SCO’s integer, not on a label', async () => {
    const high = await jsonOf<ListBody>(
      await fetch(`${app.base}/api/issues?group=severity&value=High`),
    );
    const low = await jsonOf<ListBody>(
      await fetch(`${app.base}/api/issues?group=severity&value=Low`),
    );
    expect(high.issues.every((i) => i.severity === 'High')).toBe(true);
    expect(low.issues.every((i) => i.severity === 'Low')).toBe(true);
    expect(high.totalCount).toBe(counts.bySeverity.High);
    expect(low.totalCount).toBe(counts.bySeverity.Low);
  });

  describe('rejections', () => {
    it('an unknown band is a 400, not a silently empty list', async () => {
      const res = await fetch(`${app.base}/api/issues?group=severity&value=Critical`);
      expect(res.status).toBe(400);
    });

    it('a raw SCO attribute name as the group is a 400', async () => {
      const res = await fetch(`${app.base}/api/issues?group=triggerObjectId&value=x`);
      expect(res.status).toBe(400);
    });

    it('no category at all is a 400', async () => {
      expect((await fetch(`${app.base}/api/issues`)).status).toBe(400);
    });

    it('an unknown uid is a 404', async () => {
      const res = await fetch(`${app.base}/api/issues/no-such-issue-${Date.now()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('detail', () => {
    it('reads back the issue the list showed, with its detail-only fields', async () => {
      const [kpi] = Object.keys(counts.byKpi);
      const list = await jsonOf<ListBody>(
        await fetch(
          kpi
            ? `${app.base}/api/issues?group=kpi&value=${encodeURIComponent(kpi)}`
            : `${app.base}/api/issues?group=workqueue&value=all`,
        ),
      );
      const row = list.issues[0];
      if (!row) return expect(list.totalCount).toBe(0);
      const res = await fetch(`${app.base}/api/issues/${encodeURIComponent(row.uid)}`);
      expect(res.status, await res.clone().text()).toBe(200);
      const { issue } = await jsonOf<{ issue: IssueDetail }>(res);
      expect(issue.uid).toBe(row.uid);
      expect(issue.description).toBe(row.description);
      expect(issue.severity).toBe(row.severity);
      expect(issue.status).toBe(row.status);
      // Documents whether the sample data carries issueData / an analysis at all.
      console.log('[SC-2702] detail extras:', JSON.stringify({
        issueData: issue.issueData !== null,
        resolutionNote: issue.resolutionNote !== null,
        latestAnalysis: issue.latestAnalysis !== null,
      }));
    });
  });

  // Raw SCO behaviour behind the route. These pin the assumptions the route is
  // built on; if SCO changes, these fail before the page misleads anyone.
  describe('SCO issue API contract', () => {
    it('clamps pageSize to 1000 — asking for more returns at most 1000', async () => {
      const page = await app.iris.issues.list({ pageSize: 5000 });
      expect(page.rows.length).toBeLessThanOrEqual(SCO_MAX_PAGE_SIZE);
      expect(page.pageSize).toBe(SCO_MAX_PAGE_SIZE);
    });

    it('a pageIndex past the end is an empty page, and reports totalCount 0', async () => {
      // Observed: past the last page SCO reports totalCount 0 rather than the
      // real match count, so the page must take its total from the FIRST page.
      const page = await app.iris.issues.list({ pageSize: 10, pageIndex: 1_000_000 });
      expect(page.rows).toEqual([]);
      expect(page.totalCount).toBe(0);
    });

    it('IGNORES an unknown filter — the reason the route validates its own vocabulary', async () => {
      const page = await app.iris.issues.list({
        pageSize: 1,
        filters: { notAnAttribute: 'whatever' },
      });
      expect(page.totalCount).toBe(counts.total);
    });

    it('a filter value matching nothing returns an empty page, not an error', async () => {
      const page = await app.iris.issues.list({ filters: { status: 'no-such-status' } });
      expect(page.rows).toEqual([]);
      expect(page.totalCount).toBe(0);
    });

    it('rejects a search above its bound-parameter limit, as a 500', async () => {
      // SC.Core.API.ApiBaseImpl throws "Only 20 filters can be applied to a
      // search." when the where clause exceeds 21 bound parameters — and a
      // comma-separated value spends one per value, so ONE filter can trip it.
      // SCO reports it as a 500, not a 400, which is why IssueRestClient guards
      // the filter count itself instead of relying on SCO's answer.
      const values = Array.from({ length: 22 }, (_, i) => `s${i}`).join(',');
      const res = await fetch(
        `${app.base}/api/scdata/v1/issues?status=${encodeURIComponent(values)}`,
      );
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).toMatch(/20 filters/);
    });

    it('ignores 21 UNKNOWN parameters entirely — they are not filters at all', async () => {
      // The dangerous half: SCO iterates its own attribute list, so misspelled
      // parameters never narrow anything and never error.
      const params = new URLSearchParams({ pageSize: '1' });
      for (let i = 0; i < 21; i++) params.set(`f${i}`, 'x');
      const res = await fetch(`${app.base}/api/scdata/v1/issues?${params}`);
      expect(res.status).toBe(200);
      expect(Number(res.headers.get('totalcount'))).toBe(counts.total);
    });
  });
});
