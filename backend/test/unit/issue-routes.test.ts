/**
 * /api/issues routes over a fake SCO. Weighted to the rejections: SCO IGNORES query
 * parameters it does not recognize, so a category the page did not send must fail
 * here with a 400 — otherwise a typo would quietly return every issue in the system
 * under whatever heading the user clicked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createIssueRouter, ISSUE_LIST_CAP } from '../../src/server/issue-routes.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import { apiNotFound } from '../../src/server/error-middleware.js';
import type { IrisServices } from '../../src/iris/index.js';
import type { ScoIssue, ScoIssuePage, ScoIssueQuery } from '../../src/iris/issue-rest-client.js';
import type { IssueCounts, IssueDetail, IssueRow } from '../../src/issues/issue-list.js';
import { ISSUE_CLASS } from '../../src/iris/issues-ops.js';
import { IrisHttpError } from '../../src/iris/iris-error.js';

interface ListBody {
  issues: IssueRow[];
  totalCount: number;
  truncated: boolean;
  cap: number;
}

interface Fake {
  iris: IrisServices;
  /** Every query the router passed to the SCO client. */
  queries: ScoIssueQuery[];
}

function fakeIris(opts: {
  page?: Partial<ScoIssuePage>;
  issue?: ScoIssue | null;
  countRows?: Record<string, unknown>[];
  classMissing?: boolean;
  listError?: Error;
}): Fake {
  const queries: ScoIssueQuery[] = [];
  const iris = {
    atelier: {
      async query(sql: string) {
        if (sql.includes('%Dictionary.CompiledClass')) {
          return opts.classMissing
            ? []
            : [{ Name: ISSUE_CLASS, SqlSchemaName: 'SC_Data', SqlTableName: 'Issue' }];
        }
        return opts.countRows ?? [];
      },
    },
    issues: {
      async list(query: ScoIssueQuery): Promise<ScoIssuePage> {
        queries.push(query);
        if (opts.listError) throw opts.listError;
        return {
          rows: [],
          totalCount: 0,
          returnCount: 0,
          pageSize: ISSUE_LIST_CAP,
          pageIndex: 0,
          ...opts.page,
        };
      },
      async get(): Promise<ScoIssue | null> {
        return opts.issue ?? null;
      },
    },
  } as unknown as IrisServices;
  return { iris, queries };
}

let server: Server;

/** res.json() is `unknown` under strict mode; assert the shape at the call site. */
async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function start(iris: IrisServices): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api/issues', createIssueRouter(iris));
  app.use(apiNotFound());
  app.use(errorEnvelope(false));
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

describe('GET /api/issues', () => {
  it('rejects a request with no category instead of listing everything', async () => {
    const base = await start(fakeIris({}).iris);
    const res = await fetch(`${base}/api/issues`);
    expect(res.status).toBe(400);
    expect((await bodyOf<{ code: string }>(res)).code).toBe('VALIDATION');
  });

  it('rejects a raw SCO attribute name as the group', async () => {
    const base = await start(fakeIris({}).iris);
    expect((await fetch(`${base}/api/issues?group=status&value=open`)).status).toBe(400);
  });

  it('rejects an unknown severity band', async () => {
    const base = await start(fakeIris({}).iris);
    expect((await fetch(`${base}/api/issues?group=severity&value=Critical`)).status).toBe(400);
  });

  it('rejects a KPI category with no KPI name', async () => {
    const base = await start(fakeIris({}).iris);
    expect((await fetch(`${base}/api/issues?group=kpi&value=`)).status).toBe(400);
  });

  it('a repeated query parameter does not slip through as an array', async () => {
    // Express parses ?group=a&group=b into an array; a non-string must be rejected.
    const base = await start(fakeIris({}).iris);
    expect((await fetch(`${base}/api/issues?group=kpi&group=severity&value=High`)).status).toBe(400);
  });

  it('asks SCO for a band as a range filter, capped at one page', async () => {
    const fake = fakeIris({});
    const base = await start(fake.iris);
    const res = await fetch(`${base}/api/issues?group=severity&value=high`);
    expect(res.status).toBe(200);
    expect(fake.queries).toEqual([
      { filters: { severity: '3..' }, pageSize: ISSUE_LIST_CAP },
    ]);
  });

  it('reports the real total and flags a capped list', async () => {
    const rows: ScoIssue[] = Array.from({ length: 3 }, (_, i) => ({
      uid: `u${i}`,
      description: 'Late',
      triggerType: 'KPI',
      triggerObjectId: 'LateDelivery',
      severity: 2,
      status: 'open',
    }));
    const base = await start(fakeIris({ page: { rows, totalCount: 8281 } }).iris);
    const body = await bodyOf<ListBody>(await fetch(`${base}/api/issues?group=kpi&value=LateDelivery`));
    expect(body.totalCount).toBe(8281);
    expect(body.truncated).toBe(true);
    expect(body.cap).toBe(ISSUE_LIST_CAP);
    expect(body.issues).toHaveLength(3);
    expect(body.issues[0]).toMatchObject({ severity: 'Medium', urgency: null, status: 'Open' });
  });

  it('an empty category is a 200 with no issues, not a 404', async () => {
    const base = await start(fakeIris({}).iris);
    const res = await fetch(`${base}/api/issues?group=severity&value=High`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ issues: [], totalCount: 0, truncated: false });
  });

  it('rejects urgency as a category — it is a column, not a nav group', async () => {
    const fake = fakeIris({});
    const base = await start(fake.iris);
    expect((await fetch(`${base}/api/issues?group=urgency&value=High`)).status).toBe(400);
    expect(fake.queries).toEqual([]); // never reached SCO
  });

  it('an SCO failure surfaces as a 5xx envelope, not as an empty list', async () => {
    const base = await start(
      fakeIris({ listError: new IrisHttpError(500, 'SCO blew up') }).iris,
    );
    const res = await fetch(`${base}/api/issues?group=workqueue&value=all`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await bodyOf<{ error: string }>(res)).error).toMatch(/SCO blew up/);
  });
});

describe('GET /api/issues/counts', () => {
  it('folds one grouped query into every badge', async () => {
    const base = await start(
      fakeIris({
        countRows: [
          { tt: 'KPI', toid: 'LateDelivery', sev: 2, st: 'open', c: 8281 },
          { tt: 'KPI', toid: 'LateDelivery', sev: 3, st: 'workflow', c: 3238 },
          { tt: 'externalEvent', toid: 'Storm', sev: 1, st: 'closed', c: 641 },
        ],
      }).iris,
    );
    const { counts } = await bodyOf<{ counts: IssueCounts }>(await fetch(`${base}/api/issues/counts`));
    expect(counts.total).toBe(12160);
    expect(counts.byKpi).toEqual({ LateDelivery: 11519 });
    expect(counts.bySeverity).toEqual({ High: 3238, Medium: 8281, Low: 641 });
    expect(counts.workQueue).toBe(3238);
  });

  it('"counts" is the counts route, never read as an issue uid', async () => {
    const base = await start(fakeIris({ countRows: [] }).iris);
    const body = await bodyOf<Record<string, unknown>>(await fetch(`${base}/api/issues/counts`));
    expect(body).toHaveProperty('counts');
    expect(body).not.toHaveProperty('issue');
  });

  it('an instance with no Issue class is a 404, not an empty nav', async () => {
    const base = await start(fakeIris({ classMissing: true }).iris);
    const res = await fetch(`${base}/api/issues/counts`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/issues/:uid', () => {
  it('an unknown uid is a 404 envelope', async () => {
    const base = await start(fakeIris({ issue: null }).iris);
    const res = await fetch(`${base}/api/issues/does-not-exist`);
    expect(res.status).toBe(404);
    expect((await bodyOf<{ code: string }>(res)).code).toBe('NOT_FOUND');
  });

  it('returns the detail fields the list does not carry', async () => {
    const base = await start(
      fakeIris({
        issue: {
          uid: 'g-1',
          description: 'Late',
          status: 'closed',
          issueData: '{"days":8}',
          resolutionNote: 'Expedited',
          triggerType: 'KPI',
          triggerObjectId: 'LateDelivery',
          latestAnalysis: { status: 'completed' },
        },
      }).iris,
    );
    const { issue } = await bodyOf<{ issue: IssueDetail }>(await fetch(`${base}/api/issues/g-1`));
    expect(issue).toMatchObject({
      uid: 'g-1',
      status: 'Closed',
      kpi: 'LateDelivery',
      issueData: '{"days":8}',
      resolutionNote: 'Expedited',
      latestAnalysis: { status: 'completed' },
    });
  });
});
