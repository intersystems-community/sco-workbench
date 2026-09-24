import { Router, type Request, type Response } from 'express';
import type { Env } from '../config/env.js';
import { suggestMapping, type AutoMapRequest, type SourceField, type TargetProperty } from '../util/auto-map.js';

/**
 * REST route for the Mapping step's "Auto-map" button:
 *
 *   POST /api/data-integration/auto-map   AI-suggested source→target mapping
 *
 * The body is the field/property lists from the wizard; the response is the
 * suggested pairings. A COMPLETED call returns 200 with { ok, ... } — an LLM/parse
 * failure is a normal { ok: false } the UI handles (it falls back to a local
 * heuristic), not an HTTP error. Only a malformed body is a 4xx. Field names are
 * user schema, not secrets; nothing here is logged. Same /api/data-integration
 * prefix (excluded from the IRIS proxy via LOCAL_API_PREFIXES) so it reaches Express.
 */
export function createAutoMapRouter(env: Env): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const body = req.body;
    const targetClass = typeof body?.targetClass === 'string' ? body.targetClass.trim() : '';
    const sourceFields = readSourceFields(body?.sourceFields);
    const targetProperties = readTargetProperties(body?.targetProperties);
    if (!targetClass || !sourceFields || !targetProperties) {
      return res.status(400).json({ error: 'targetClass, sourceFields[] and targetProperties[] are required.' });
    }
    const request: AutoMapRequest = { sourceFields, targetClass, targetProperties };
    const result = await suggestMapping(env, request);
    return res.json(result);
  });

  return router;
}

/** Coerce the request's sourceFields; null if the shape is wrong. */
function readSourceFields(value: unknown): SourceField[] | null {
  if (!Array.isArray(value)) return null;
  const out: SourceField[] = [];
  for (const f of value) {
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    if (!name) continue;
    out.push({ name, type: typeof f?.type === 'string' ? f.type : '' });
  }
  return out;
}

/** Coerce the request's targetProperties; null if the shape is wrong. */
function readTargetProperties(value: unknown): TargetProperty[] | null {
  if (!Array.isArray(value)) return null;
  const out: TargetProperty[] = [];
  for (const p of value) {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!name) continue;
    out.push({ name, dataType: typeof p?.dataType === 'string' ? p.dataType : '', required: !!p?.required });
  }
  return out;
}
