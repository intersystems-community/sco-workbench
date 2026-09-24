import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { posix as posixPath } from 'node:path';
import type { Env } from '../config/env.js';
import type { IrisServices } from '../iris/index.js';
import type { IntegrationCaseRepository } from '../db/integration-cases.js';
import { putFileToIris, deleteFileFromIris } from '../iris/file-ops.js';
import { toIrisError } from '../iris/normalize-error.js';
import { ValidationError } from '../iris/iris-error.js';
import { normalizeAwsCredentialsToDefaultProfile } from '../util/aws-credentials.js';
import { decryptBytes } from '../util/crypto-secret.js';
import { PendingUploadStore, type UploadKind } from './upload-store.js';

/**
 * Data Integration file uploads → materialize into the user's IRIS container.
 *
 *   POST /upload              multipart (field `file`, field `kind`) — accept a
 *                             file, hold its bytes IN MEMORY, return the
 *                             deterministic path it WILL occupy inside IRIS.
 *   POST /materialize         { fileIds } — stream each file into IRIS.
 *   POST /materialize/cleanup { fileIds } — delete each from IRIS + forget it.
 *
 * On upload the bytes are held only in this process's memory (the shared
 * PendingUploadStore + multer.memoryStorage's Buffer). At step-save the
 * integration-case router copies them into SQLite (durable), so materialize can
 * source bytes from the in-memory store when fresh OR from the SQLite copy after
 * a refresh/restart (see resolveForMaterialize). The IRIS-side copy lives under
 * the configured dir and is cleared on an IRIS restart, so a re-materialize from
 * the durable SQLite copy restores it.
 *
 * The IRIS path is DERIVED at upload time from the configured dir + a random
 * fileId, so the UI gets the final path synchronously and every downstream
 * consumer (adapter config, the agent) uses that one value; the bytes are pushed
 * to that exact path later, at Deploy (materialize).
 *
 * Mounted under the proxy-excluded `/api/data-integration` prefix (already in
 * LOCAL_API_PREFIXES) and behind the `/api/*` bearer auth.
 */

/** Max accepted file size — a memory-safety bound, not a persistence one. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Sanitize the original filename for use in a path segment: keep the base name,
 * strip any directory parts, and allow only a safe charset. Prevents a crafted
 * name (e.g. `../../etc/authorized_keys`) from escaping the target dir — the
 * fileId prefix also guarantees uniqueness so two uploads never collide.
 */
function safeName(original: string): string {
  const base = original.replace(/^.*[\\/]/, ''); // drop any path prefix
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length ? cleaned : 'file';
}

/**
 * The bytes to actually stage into IRIS for a pending upload.
 *
 * Only an `aws-cred` file is normalized to an AWS `[default]` profile: the IRIS
 * Cloud adapter (`EnsLib.AmazonS3.InboundAdapter`) hands ProviderCredentialsFile
 * to the AWS Java SDK, which reads only `[default]`, so a file whose sole profile
 * is e.g. `[123_SomeRole]` fails at deploy with `No AWS profile named 'default'`.
 * We trust the frontend's kind label — SSH `key` files and `csv` data files are
 * staged verbatim and never parsed. The normalizer is still a no-op when the creds
 * file already exposes a usable `[default]`, so a canonical file round-trips
 * unchanged. Falls back to the original bytes if decoding as UTF-8 would change
 * them (a binary/oddly-encoded creds file), so we never corrupt content.
 */
function bytesForIris(bytes: Buffer, kind: UploadKind): Buffer {
  if (kind !== 'aws-cred') return bytes;
  const text = bytes.toString('utf8');
  // Guard: only operate on clean UTF-8 text; binary content round-trips unchanged.
  if (!Buffer.from(text, 'utf8').equals(bytes)) return bytes;
  const normalized = normalizeAwsCredentialsToDefaultProfile(text);
  return normalized.changed ? Buffer.from(normalized.text, 'utf8') : bytes;
}

export function createUploadRouter(
  iris: IrisServices,
  env: Env,
  store: PendingUploadStore,
  cases: IntegrationCaseRepository,
): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

  /** Resolve a fileId's bytes for materialization: prefer the in-memory staging
   *  store (freshly uploaded, not yet released), else fall back to the durable
   *  SQLite copy (survives refresh/restart), decrypting secret files. Returns the
   *  bytes + the metadata needed to stage them, or null when the file is unknown. */
  function resolveForMaterialize(
    fileId: string,
  ): { irisPath: string; bytes: Buffer; secret: boolean; kind: UploadKind } | null {
    const held = store.get(fileId);
    if (held?.bytes) {
      return { irisPath: held.irisPath, bytes: held.bytes, secret: held.secret, kind: held.kind };
    }
    const stored = cases.getFileBytes(fileId);
    if (stored) {
      const bytes = stored.encrypted ? decryptBytes(stored.bytes) : stored.bytes;
      return { irisPath: stored.irisPath, bytes, secret: stored.secret, kind: stored.kind as UploadKind };
    }
    return null;
  }

  // --- Upload one file (held in memory) ---
  router.post('/', upload.single('file'), (req: Request, res: Response, next: NextFunction) => {
    try {
      store.evictExpired();
      const file = req.file;
      if (!file) throw new ValidationError('A file is required (multipart field "file").');

      const rawKind = req.body?.kind;
      const kind: UploadKind = rawKind === 'ssh-key' || rawKind === 'aws-cred' ? rawKind : 'csv';
      // Both key material and AWS credentials are secrets → key dir, 0600.
      const secret = kind === 'ssh-key' || kind === 'aws-cred';

      const fileId = randomUUID();
      const dir = secret ? env.SCO_UPLOAD_KEY_DIR : env.SCO_UPLOAD_CSV_DIR;
      const storedName = `${fileId}_${safeName(file.originalname)}`;
      const irisPath = posixPath.join(dir, storedName);

      store.set({
        fileId,
        originalName: file.originalname,
        kind,
        irisPath,
        secret,
        bytes: file.buffer,
        addedAt: Date.now(),
      });

      return res.json({ fileId, irisPath, originalName: file.originalname, kind });
    } catch (err) {
      return next(err instanceof ValidationError ? err : toIrisError(err, { op: 'file upload' }));
    }
  });

  // --- Materialize held files into IRIS (all-or-nothing) ---
  // Always 200 with per-file results: a failed materialize is a normal outcome
  // the UI renders (like Test Connection), not an HTTP error. Only a malformed
  // body is a 4xx.
  //
  // A batch is atomic: if ANY file fails, the ones that already landed in IRIS
  // are rolled back (deleted) so a half-materialized set — e.g. a 0600 private
  // key written while the CSV failed — never leaves an orphaned secret on the
  // IRIS filesystem. Buffers are released only when the whole batch succeeds, so
  // a rolled-back batch stays retryable without re-uploading.
  router.post('/materialize', (req: Request, res: Response, next: NextFunction) => {
    const fileIds = req.body?.fileIds;
    if (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== 'string')) {
      return next(new ValidationError('fileIds (string[]) is required.'));
    }

    const results = (fileIds as string[]).map((fileId) => {
      const src = resolveForMaterialize(fileId);
      if (!src) return { fileId, irisPath: '', ok: false, error: 'Unknown or expired upload; re-upload the file.' };
      try {
        putFileToIris(iris.native, { irisPath: src.irisPath, bytes: bytesForIris(src.bytes, src.kind), secret: src.secret });
        return { fileId, irisPath: src.irisPath, ok: true as const };
      } catch (err) {
        return { fileId, irisPath: src.irisPath, ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    });

    if (results.some((r) => !r.ok)) {
      // Roll back every file that DID land, so no orphan (esp. a secret) remains.
      for (const r of results) {
        if (r.ok) {
          try {
            deleteFileFromIris(iris.native, r.irisPath);
          } catch {
            // best-effort — the file may already be gone
          }
        }
      }
      // Report the successes as not-applied so the UI sees a coherent failure.
      const rolledBack = results.map((r) => (r.ok ? { ...r, ok: false, error: 'Rolled back: another file in this batch failed to stage.' } : r));
      return res.json({ results: rolledBack });
    }

    // Whole batch landed — release the in-memory Buffers (bytes are now in IRIS
    // and the durable SQLite copy remains for a later re-materialize), keeping the
    // lightweight entry so cleanup can still delete the file from IRIS later.
    for (const fileId of fileIds as string[]) {
      const u = store.get(fileId);
      if (u) u.bytes = null;
    }
    return res.json({ results });
  });

  // --- Cleanup: delete from IRIS and forget the held bytes ---
  router.post('/materialize/cleanup', (req: Request, res: Response, next: NextFunction) => {
    const fileIds = req.body?.fileIds;
    if (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== 'string')) {
      return next(new ValidationError('fileIds (string[]) is required.'));
    }

    for (const fileId of fileIds as string[]) {
      const u = store.get(fileId);
      const irisPath = u?.irisPath ?? cases.getFileBytes(fileId)?.irisPath;
      if (irisPath) {
        try {
          deleteFileFromIris(iris.native, irisPath);
        } catch {
          // Best-effort: a file that was never materialized (or already gone) is fine.
        }
      }
      store.delete(fileId);
    }
    return res.json({ ok: true });
  });

  return router;
}
