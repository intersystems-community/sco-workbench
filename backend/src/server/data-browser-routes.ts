/**
 * Read-only row counts for the Dashboard, mirroring `createCubeRouter`'s shape.
 *
 * Takes only `iris` — no repository, no `Database`. That is deliberate: the
 * count is stateless, and staying repository-free keeps this router's tests
 * runnable on hosts where `better-sqlite3` has no binding (four existing test
 * files are red for exactly that reason).
 *
 * NOTE for anyone adding a route here: `/api/data-browser` must stay listed in
 * `LOCAL_API_PREFIXES` in `iris-proxy.ts`. The catch-all IRIS proxy mounts
 * before the local routers, so an unlisted local path is silently forwarded to
 * IRIS and 404s.
 */
import { Router } from 'express';
import type { IrisServices } from '../iris/index.js';
import { countRows, countRowsMany } from '../iris/row-count-ops.js';
import { toIrisError } from '../iris/normalize-error.js';
import { ValidationError } from '../iris/iris-error.js';

export function createDataBrowserRouter(iris: IrisServices): Router {
  const router = Router();

  /**
   * GET /:className/count — exact row total for a persistent class.
   * `:className` is scmodel's `className` (e.g. `SC.Data.BOM`); the SQL form
   * (`SC_Data.BOM`) resolves too. No `400` branch: the only input is a path
   * param, which either resolves or 404s.
   *
   * `countRows` throws `ClassNotFoundError` (a NotFoundError, → 404 with
   * candidates); any other failure is normalized (→ 502). Both go through the
   * shared error envelope.
   */
  router.get('/:className/count', async (req, res, next) => {
    try {
      const count = await countRows(iris.atelier, req.params.className);
      return res.json(count);
    } catch (err) {
      return next(toIrisError(err, { op: 'row count' }));
    }
  });

  /**
   * POST /counts — bulk exact row totals for the dashboard's Table dropdown.
   * Body `{ classNames: string[] }`; response `{ counts: Record<className,
   * RowCountResult> }`. POST because the input is a list (same shape as the D2
   * /chart-data POST). Per-item failures ride in the map as `{ ok: false }`;
   * only a bad request body is a 400. Repository-free like the count route.
   *
   * The 400 raises `ValidationError` and hands it to `next(err)`, matching the
   * spec's "same shape as the /chart-data POST" (dashboard-routes.ts:66,69) →
   * the error middleware emits `{ code: 'VALIDATION', httpStatus: 400 }`. Do NOT
   * hand-roll `res.status(400).json(...)` here: that both departs from the cited
   * precedent and invents a `code` token no producer/consumer uses.
   */
  router.post('/counts', async (req, res, next) => {
    const classNames = (req.body as { classNames?: unknown })?.classNames;
    if (!Array.isArray(classNames) || classNames.some((n) => typeof n !== 'string')) {
      return next(new ValidationError('classNames must be an array of strings.'));
    }
    try {
      const counts = await countRowsMany(iris.atelier, classNames as string[]);
      return res.json({ counts });
    } catch (err) {
      return next(toIrisError(err, { op: 'bulk row count' }));
    }
  });

  return router;
}
