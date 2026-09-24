import { Router, type Request, type Response, type NextFunction } from 'express';
import type { IrisServices } from '../iris/index.js';
import type { IntegrationCaseRepository } from '../db/integration-cases.js';
import { decryptCasePasswords, credentialFromCase } from './integration-case-routes.js';
import { toIrisError } from '../iris/normalize-error.js';
import { ValidationError, IrisProtocolError } from '../iris/iris-error.js';

/**
 * Data Integration → create/update the IRIS production Credentials entry a
 * pipeline's adapter references (SQL `DSN` login, or SFTP/FTP `Credentials`).
 *
 *   POST /               { name, username, password } — upsert the credential.
 *   POST /from-case/:id  upsert the credential for a SAVED case, reading the
 *                        DECRYPTED username/password from SQLite (Deploy path).
 *
 * The workbench generates the entry NAME (Data Source Name + uuid) and persists
 * it on the pipeline; this route creates the matching entry so the adapter's
 * `Credentials` setting resolves. Done as a predefined backend op over the Native
 * SDK (like file materialization) — NOT by the agent — so the username/password
 * never travel through the LLM prompt.
 *
 * The `/from-case/:id` variant exists because a restored case only holds a
 * REDACTED password in the browser (the plaintext never leaves the server), so at
 * Deploy the credential must be created from the decrypted SQLite copy rather than
 * from a value the frontend can supply. The credential NAME still travels in the
 * prompt exactly as before — only where the PASSWORD is read from changed.
 *
 * `Ens.Config.Credentials.SetCredential(name, user, pass, 1)` upserts by
 * SystemName (the primary key), so re-deploying the same pipeline overwrites the
 * one entry in place rather than orphaning a new one.
 *
 * Mounted under the proxy-excluded `/api/data-integration` prefix and behind the
 * `/api/*` bearer auth.
 */
export function createCredentialRouter(iris: IrisServices, cases?: IntegrationCaseRepository): Router {
  const router = Router();

  /** Upsert one credential in IRIS; throws IrisProtocolError on a bad status. */
  const setCredential = (name: string, username: string, password: string): void => {
    const status = iris.native.callValue('Ens.Config.Credentials', 'SetCredential', name, username, password, 1);
    const decoded = iris.native.decodeStatus(status);
    if (!decoded.ok) throw new IrisProtocolError(`Failed to create SCO credential "${name}": ${decoded.text}`);
  };

  router.post('/', (req: Request, res: Response, next: NextFunction) => {
    const { name, username, password } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      return next(new ValidationError('name (string) is required.'));
    }
    if (typeof username !== 'string' || !username) {
      return next(new ValidationError('username (string) is required.'));
    }
    if (typeof password !== 'string') {
      return next(new ValidationError('password (string) is required.'));
    }

    try {
      setCredential(name, username, password);
      return res.json({ ok: true, name });
    } catch (err) {
      return next(err instanceof IrisProtocolError ? err : toIrisError(err, { op: 'create credential' }));
    }
  });

  // Deploy path: create the credential for a saved case from its DECRYPTED source.
  router.post('/from-case/:id', (req: Request, res: Response, next: NextFunction) => {
    if (!cases) return next(new IrisProtocolError('Case store is not available.'));
    const found = cases.get(String(req.params.id));
    if (!found) return next(new ValidationError('No such integration case.'));
    try {
      const cred = credentialFromCase(decryptCasePasswords(found));
      // File / cloud adapters reference no Credentials entry — nothing to create.
      if (!cred) return res.json({ ok: true, name: null });
      setCredential(cred.name, cred.username, cred.password);
      return res.json({ ok: true, name: cred.name });
    } catch (err) {
      return next(err instanceof IrisProtocolError ? err : toIrisError(err, { op: 'create credential' }));
    }
  });

  return router;
}
