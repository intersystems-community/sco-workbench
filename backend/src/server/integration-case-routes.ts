import { Router, type Request, type Response, type NextFunction } from 'express';
import type {
  IntegrationCaseRepository,
  IntegrationCase,
  IntegrationCaseStatus,
} from '../db/integration-cases.js';
import type { PendingUploadStore } from './upload-store.js';
import { ValidationError, IrisProtocolError } from '../iris/iris-error.js';
import { encryptSecret, decryptSecret, isEncrypted, encryptBytes } from '../util/crypto-secret.js';

/**
 * Persistence for Data Integration cases (the DI wizard). Unlike the ephemeral
 * upload store, these rows survive refresh/restart:
 *
 *   GET    /api/data-integration/cases            list cases (passwords redacted)
 *   GET    /api/data-integration/cases/:id        one case + file metadata (redacted)
 *   POST   /api/data-integration/cases/save       upsert a (possibly partial) case
 *   DELETE /api/data-integration/cases/:id        delete (409 if deployed)
 *   POST   /api/data-integration/cases/:id/files  persist an uploaded file's bytes
 *   DELETE /api/data-integration/cases/:id/files/:slot  clear a slot
 *
 * DB/FTP passwords are encrypted at rest (AES-256-GCM) and NEVER returned to the
 * browser: a GET replaces any stored password with the SENTINEL so the UI can
 * show a "saved" state without shipping the secret. On save, a field left as the
 * SENTINEL keeps the previously stored ciphertext (the user didn't retype it).
 * Plaintext is reconstructed only server-side, at Deploy.
 *
 * Mounted after express.json(), NOT behind the IRIS proxy (see LOCAL_API_PREFIXES).
 */

/** Placeholder the UI shows (and echoes back on save) for an already-saved
 *  password, so the plaintext never leaves the server. */
const SENTINEL = '__saved__';

/** Password fields inside `definition.source` that are encrypted at rest. */
const PASSWORD_KEYS = ['dbPassword', 'ftpPassword', 'apiPassword'] as const;

/** Slots that carry SECRET file material (encrypted at rest). */
const SECRET_SLOTS = new Set(['publicKey', 'privateKey', 'cloudCred']);

export function createIntegrationCaseRouter(
  cases: IntegrationCaseRepository,
  store: PendingUploadStore,
): Router {
  const router = Router();

  // --- List all cases (passwords redacted) ---
  router.get('/', (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ cases: cases.list().map(redactCase) });
    } catch (err) {
      next(new IrisProtocolError(`Failed to list integration cases: ${message(err)}`, { cause: err }));
    }
  });

  // --- One case (redacted) + its file metadata (for restore) ---
  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const found = cases.get(String(req.params.id));
      if (!found) return next(new ValidationError('No such integration case.'));
      return res.json({ case: redactCase(found), files: cases.getFilesMeta(found.id) });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to read integration case: ${message(err)}`, { cause: err }));
    }
  });

  // --- Save (upsert) a case; may be partial (an early step) ---
  router.post('/save', (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.body?.case as RawCase | undefined;
    if (!incoming || typeof incoming !== 'object' || typeof incoming.id !== 'string' || !incoming.id.trim()) {
      return next(new ValidationError('An integration `case` with an `id` is required.'));
    }
    const id = incoming.id.trim();
    const name = typeof incoming.name === 'string' && incoming.name.trim() ? incoming.name.trim() : 'Untitled integration';
    try {
      const existing = cases.get(id);
      const definition = encryptPasswords(incoming as unknown as Record<string, unknown>, existing);
      // `everDeployed` is SERVER-owned: it records that this pipeline's classes and
      // hosts exist in SCO, which stays true no matter how the case is later edited.
      // Carried over from the stored case (never taken from the request, so a client
      // cannot clear it) and normalized on both sides before the comparison below, so
      // the marker itself never counts as a change.
      const everDeployed = existing?.definition?.everDeployed === true;
      if (everDeployed) definition.everDeployed = true;
      else delete definition.everDeployed;
      // A `deployed` status asserts that the STORED definition is what is live in
      // SCO. So a save that CHANGES the definition (or the name) invalidates that
      // claim and the case goes back to draft — the UI's badge follows the status
      // echoed back here. An unchanged re-save (pressing Save on a step without
      // editing anything) keeps it deployed.
      const unchanged =
        !!existing && existing.name === name && canonicalJson(existing.definition) === canonicalJson(definition);
      const status: IntegrationCaseStatus = existing?.status === 'deployed' && unchanged ? 'deployed' : 'draft';
      const saved = cases.upsert(id, name, status, definition);
      return res.json({ ok: true, id: saved.id, status: saved.status });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to save integration case: ${message(err)}`, { cause: err }));
    }
  });

  // --- Set a case's status (draft ↔ deployed) ---
  // The agent's real deploy outcome drives draft → deployed; /save deliberately
  // never upgrades a case itself, so this is the one place the status advances.
  router.post('/:id/status', (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    const status = req.body?.status;
    if (status !== 'draft' && status !== 'deployed') {
      return next(new ValidationError('`status` must be "draft" or "deployed".'));
    }
    try {
      const found = cases.get(id);
      if (!found) return next(new ValidationError('No such integration case.'));
      if (status === 'deployed') {
        // Stamp the server-owned `everDeployed` marker alongside the status. The
        // status can later fall back to draft (a save that edits the definition), but
        // the classes and hosts this deploy created still exist in SCO — which is what
        // the delete guard below needs to know, and what makes the button read
        // "Redeploy" from then on. The stored definition is re-written verbatim (no
        // re-encryption): it already holds ciphertext.
        cases.upsert(id, found.name, 'deployed', { ...found.definition, everDeployed: true });
      } else {
        cases.setStatus(id, status);
      }
      return res.json({ ok: true, id, status });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to update integration case status: ${message(err)}`, { cause: err }));
    }
  });

  // --- Delete a case (blocked once it has been deployed) ---
  // Keyed on `everDeployed`, not just the current status: editing a deployed case
  // sends its status back to draft, but the classes and production hosts that deploy
  // created are still live in SCO, and deleting the case would orphan them with no way
  // back (there is no tool to delete a compiled class).
  router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    try {
      const found = cases.get(id);
      if (found?.status === 'deployed' || found?.definition?.everDeployed === true) {
        return res.status(409).json({ ok: false, error: 'A deployed integration case cannot be deleted.' });
      }
      cases.delete(id);
      return res.json({ ok: true });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to delete integration case: ${message(err)}`, { cause: err }));
    }
  });

  // --- Persist an uploaded file's bytes into SQLite (durable) for a case slot ---
  router.post('/:id/files', (req: Request, res: Response, next: NextFunction) => {
    const caseId = String(req.params.id);
    const slot = String(req.body?.slot ?? '');
    const fileId = String(req.body?.fileId ?? '');
    if (!slot || !fileId) return next(new ValidationError('`slot` and `fileId` are required.'));
    try {
      const held = store.get(fileId);
      if (!held || !held.bytes) {
        return next(new ValidationError('Unknown or expired upload; re-upload the file.'));
      }
      const encrypted = SECRET_SLOTS.has(slot);
      const bytes = encrypted ? encryptBytes(held.bytes) : held.bytes;
      cases.putFile(
        caseId,
        {
          fileId,
          slot,
          kind: held.kind,
          originalName: held.originalName,
          irisPath: held.irisPath,
          secret: held.secret,
          encrypted,
        },
        bytes,
      );
      return res.json({ ok: true, fileId, slot, originalName: held.originalName, irisPath: held.irisPath });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to persist uploaded file: ${message(err)}`, { cause: err }));
    }
  });

  // --- Clear a slot's persisted file ---
  router.delete('/:id/files/:slot', (req: Request, res: Response, next: NextFunction) => {
    try {
      cases.clearSlot(String(req.params.id), String(req.params.slot));
      return res.json({ ok: true });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to clear file slot: ${message(err)}`, { cause: err }));
    }
  });

  return router;
}

/** Shape of an incoming case (the frontend IntegrationJob). Only `id`/`name` and
 *  the nested `source` passwords are inspected here; the rest is stored opaquely. */
interface RawCase {
  id: string;
  name?: string;
  source?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Encrypt the password fields in a case's `source` before persisting. A field
 * equal to the SENTINEL means "keep what's stored" (the UI never received the
 * plaintext, so it echoed the placeholder) → reuse the existing ciphertext. A
 * non-empty value is freshly encrypted; an empty value clears it.
 */
/**
 * JSON with object keys sorted at every depth, so two definitions can be compared
 * for EQUALITY OF CONTENT. A plain JSON.stringify would also report a difference
 * when the client merely builds the same object in a different key order, which
 * would demote a deployed case to draft on a save that changed nothing.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined) // absent and explicitly-undefined are the same thing
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function encryptPasswords(raw: Record<string, unknown>, existing: IntegrationCase | null): Record<string, unknown> {
  const def = { ...raw };
  const source = def.source && typeof def.source === 'object' ? { ...(def.source as Record<string, unknown>) } : undefined;
  if (!source) return def;
  const prevSource = (existing?.definition?.source as Record<string, unknown> | undefined) ?? {};
  for (const key of PASSWORD_KEYS) {
    const value = source[key];
    if (value === SENTINEL) {
      source[key] = prevSource[key] ?? ''; // keep the previously stored ciphertext
    } else if (typeof value === 'string' && value.length > 0) {
      source[key] = encryptSecret(value);
    } else if (typeof value === 'string') {
      source[key] = ''; // explicitly cleared
    }
  }
  def.source = source;
  return def;
}

/** Redact stored passwords for the browser: a stored (encrypted) password → the
 *  SENTINEL so the UI shows "saved"; an empty one stays empty. */
function redactCase(c: IntegrationCase): IntegrationCase {
  const source = c.definition?.source as Record<string, unknown> | undefined;
  if (!source) return c;
  const redactedSource = { ...source };
  for (const key of PASSWORD_KEYS) {
    const value = redactedSource[key];
    redactedSource[key] = isEncrypted(typeof value === 'string' ? value : '') ? SENTINEL : '';
  }
  return { ...c, definition: { ...c.definition, source: redactedSource } };
}

/**
 * Decrypt a stored case's passwords in place for server-side use at Deploy.
 * Exported so the deploy path (which reads the case from SQLite) can recover the
 * plaintext to create the IRIS credential and build the agent prompt. NEVER send
 * the result to the browser.
 */
export function decryptCasePasswords(c: IntegrationCase): IntegrationCase {
  const source = c.definition?.source as Record<string, unknown> | undefined;
  if (!source) return c;
  const decryptedSource = { ...source };
  for (const key of PASSWORD_KEYS) {
    const value = decryptedSource[key];
    if (typeof value === 'string' && value.length > 0) decryptedSource[key] = decryptSecret(value);
  }
  return { ...c, definition: { ...c.definition, source: decryptedSource } };
}

/**
 * The IRIS credential (name + username + DECRYPTED password) to create for a
 * case's source at Deploy, or null when the adapter references none (file/cloud).
 * Mirrors the frontend's `credentialFor`: only SQL and FTP/SFTP carry a
 * Credentials entry, keyed by the name frozen on the case at first save. Call on a
 * case already run through `decryptCasePasswords` so the password is plaintext.
 */
export function credentialFromCase(c: IntegrationCase): { name: string; username: string; password: string } | null {
  const source = c.definition?.source as Record<string, unknown> | undefined;
  if (!source) return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (source.type === 'database' && str(source.dbCredentialName)) {
    return { name: str(source.dbCredentialName), username: str(source.dbUsername), password: str(source.dbPassword) };
  }
  if (source.type === 'ftp' && str(source.ftpCredentialName)) {
    return { name: str(source.ftpCredentialName), username: str(source.ftpUsername), password: str(source.ftpPassword) };
  }
  return null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
