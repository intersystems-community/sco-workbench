import { Router, type Request, type Response, type NextFunction } from 'express';
import type { KpiDefinition } from '../kpi/kpi-definition.model.js';
import type { KpiDraftRepository } from '../db/kpi-drafts.js';
import type { IrisServices } from '../iris/index.js';
import { listKpiBaseObjects } from '../kpi/kpi-base-objects.js';
import { toIrisError } from '../iris/normalize-error.js';
import { ValidationError, IrisProtocolError } from '../iris/iris-error.js';

/**
 * Local draft store for the Business KPIs editor. Unlike cubes, a KPI is created
 * / updated / deleted through the SCO REST API (proxied to IRIS), so these
 * routes only persist *drafts* — an incomplete or unsubmitted edit that must
 * survive navigation without touching IRIS:
 *
 *   GET    /api/kpi-drafts               list all saved drafts
 *   GET    /api/kpi-drafts/base-objects  list valid KPI base objects (the {name}
 *                                        from SC.Core.API.Data.{name}ApiImpl)
 *   POST   /api/kpi-drafts/save          upsert a (possibly incomplete) draft
 *   DELETE /api/kpi-drafts/:name         drop a draft (called after a successful
 *                                        Submit, or when the user discards it)
 *
 * The frontend merges these drafts with the live IRIS KPI list: a KPI present
 * in IRIS is "created"; a draft row means unsaved local edits ("draft"). On a
 * successful Submit the frontend deletes the draft, so the merged list then
 * shows the single authoritative IRIS entry.
 *
 * Mounted after express.json(), NOT behind the IRIS proxy (see LOCAL_API_PREFIXES).
 */
export function createKpiDraftRouter(drafts: KpiDraftRepository, iris: IrisServices): Router {
  const router = Router();

  // --- List all saved drafts ---
  router.get('/', (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ drafts: drafts.list() });
    } catch (err) {
      next(new IrisProtocolError(`Failed to list drafts: ${message(err)}`, { cause: err }));
    }
  });

  // --- List valid KPI base objects (SC.Core.API.Data.{name}ApiImpl short names) ---
  router.get('/base-objects', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ baseObjects: await listKpiBaseObjects(iris.atelier) });
    } catch (err) {
      next(toIrisError(err, { op: 'list KPI base objects' }));
    }
  });

  // --- Save (upsert) a draft; may be incomplete ---
  router.post('/save', (req: Request, res: Response, next: NextFunction) => {
    const def = req.body?.definition as KpiDefinition | undefined;
    if (!def || typeof def !== 'object' || !def.name?.trim()) {
      return next(new ValidationError('A KPI `definition` with a name is required.'));
    }
    const name = def.name.trim();
    try {
      // A rename creates a fresh draft under the new name; drop the old one so
      // the list doesn't show a stale duplicate.
      const originalName = typeof req.body?.originalName === 'string' ? req.body.originalName.trim() : '';
      if (originalName && originalName !== name) drafts.delete(originalName);

      const saved = drafts.upsert(name, def, 'draft');
      return res.json({ ok: true, kpiName: saved.kpiName, state: saved.state });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to save draft: ${message(err)}`, { cause: err }));
    }
  });

  // --- Delete a draft (after Submit succeeds, or on discard) ---
  router.delete('/:name', (req: Request, res: Response, next: NextFunction) => {
    const name = String(req.params.name);
    try {
      drafts.delete(name);
      return res.json({ ok: true });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to delete draft: ${message(err)}`, { cause: err }));
    }
  });

  return router;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
