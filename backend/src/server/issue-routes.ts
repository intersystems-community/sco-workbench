// backend/src/server/issue-routes.ts
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { IrisServices } from '../iris/index.js';
import { toIrisError } from '../iris/normalize-error.js';
import { NotFoundError, ValidationError } from '../iris/iris-error.js';
import { SCO_MAX_PAGE_SIZE } from '../iris/issue-rest-client.js';
import { queryIssueCounts } from '../iris/issues-ops.js';
import { categoryFilters, foldCounts, toIssueDetail, toIssueRow } from '../issues/issue-list.js';

/** The page shows one uninterrupted list, capped at SCO's own page ceiling. */
export const ISSUE_LIST_CAP = SCO_MAX_PAGE_SIZE;

/**
 * Routes for the Issue Management page. MUST be in LOCAL_API_PREFIXES
 * (iris-proxy.ts) or every route is forwarded to SCO and 404s.
 *
 * Filtering and counting are server-side: SCO's issue API is paged (1000 rows
 * maximum per request) and an instance carries tens of thousands of issues, so the
 * browser cannot hold the full set and filter locally. `/counts` answers all four
 * nav dimensions with one grouped SQL query rather than one request per badge.
 *
 * HTTP↔core translation only; the mapping lives in backend/src/issues/issue-list.ts.
 */
export function createIssueRouter(iris: IrisServices): Router {
  const router = Router();

  // Nav badge counts. Declared before /:uid so "counts" is not read as a uid.
  router.get('/counts', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json({ counts: foldCounts(await queryIssueCounts(iris.atelier)) });
    } catch (err) {
      return next(toIrisError(err, { op: 'issue counts' }));
    }
  });

  // The issue list for one nav category. `group`/`value` are the page's own
  // vocabulary; categoryFilters rejects anything else with a 400 instead of
  // passing it to SCO, which ignores unknown filters and would return every issue.
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const group = typeof req.query.group === 'string' ? req.query.group : '';
      const value = typeof req.query.value === 'string' ? req.query.value : '';
      const filters = categoryFilters(group, value);
      const page = await iris.issues.list({ filters, pageSize: ISSUE_LIST_CAP });
      return res.json({
        issues: page.rows.map(toIssueRow),
        totalCount: page.totalCount,
        // True when the category holds more issues than one SCO page returns; the
        // page says so rather than pretending the list is complete.
        truncated: page.totalCount > page.rows.length,
        cap: ISSUE_LIST_CAP,
      });
    } catch (err) {
      if (err instanceof ValidationError) return next(err);
      return next(toIrisError(err, { op: 'list issues' }));
    }
  });

  // One issue, with its latest analysis when one has run.
  router.get('/:uid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = String(req.params.uid);
      const issue = await iris.issues.get(uid);
      if (!issue) return next(new NotFoundError(`No issue with uid "${uid}" was found.`));
      return res.json({ issue: toIssueDetail(issue) });
    } catch (err) {
      return next(toIrisError(err, { op: 'get issue' }));
    }
  });

  return router;
}
