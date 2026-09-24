import { Router, type Request, type Response } from 'express';
import { testJdbcConnection } from '../util/jdbc-test.js';
import { testFtpConnection } from '../util/ftp-test.js';
import { testSftpConnection } from '../util/sftp-test.js';
import { testS3Connection } from '../util/s3-test.js';
import { resolveS3Config } from '../util/aws-credentials.js';
import type { IntegrationCaseRepository } from '../db/integration-cases.js';
import { resolvePassword, resolveSecretFile, withRecoveredCloudCreds } from './di-secret-resolver.js';

/**
 * REST routes for the Data Integration "Test Connection" button, one subpath per
 * source adapter so each can be implemented independently (parallel dev, no
 * shared-file conflicts):
 *
 *   POST /api/data-integration/test-connection/sql     JDBC (IRIS) — live
 *   POST /api/data-integration/test-connection/ftp     plain FTP — live
 *   POST /api/data-integration/test-connection/sftp    SFTP (key-based) — live
 *   POST /api/data-integration/test-connection/cloud   AWS S3 — live
 *
 * A COMPLETED test always returns 200 with { ok, message } — a failed *test*
 * (unreachable host, bad credentials) is a normal result the UI renders, not an
 * HTTP error. Only a malformed request body is a 4xx. Passwords are used
 * server-side only and never logged.
 *
 * Each handler stays thin: validate the body, delegate to the adapter's logic
 * module under src/util/, and shape the response. The connection logic itself
 * lives in those modules (e.g. util/jdbc-test.ts), kept HTTP-free and unit-tested
 * in isolation. Mounted after express.json(), and excluded from the IRIS proxy
 * via LOCAL_API_PREFIXES in iris-proxy.ts so it reaches Express.
 */
export function createConnectionTestRouter(cases?: IntegrationCaseRepository): Router {
  const router = Router();

  /** A reopened case's id, sent alongside `config` so the tested-config signature
   *  stays clean; lets the handlers recover a persisted secret the browser redacted. */
  const caseIdOf = (req: Request): string | undefined =>
    typeof req.body?.caseId === 'string' && req.body.caseId.trim() ? req.body.caseId.trim() : undefined;

  // --- SQL / JDBC (real JDBC via the Java sidecar; any driver) ---
  router.post('/sql', async (req: Request, res: Response) => {
    const cfg = req.body?.config;
    const dsn = typeof cfg?.dsn === 'string' ? cfg.dsn.trim() : '';
    const username = typeof cfg?.username === 'string' ? cfg.username : '';
    // A reopened case sends the redacted sentinel; swap in the stored password.
    const password = resolvePassword(cases, caseIdOf(req), 'dbPassword', typeof cfg?.password === 'string' ? cfg.password : '');
    const driverClass = typeof cfg?.driverClass === 'string' ? cfg.driverClass.trim() : '';
    if (!dsn || !username || !driverClass) {
      return res
        .status(400)
        .json({ error: 'config.dsn, config.username and config.driverClass are required.' });
    }
    const result = await testJdbcConnection({ dsn, username, password, driverClass });
    return res.json(result);
  });

  // --- Plain FTP (username/password, direct via basic-ftp) ---
  router.post('/ftp', async (req: Request, res: Response) => {
    const cfg = req.body?.config;
    const host = typeof cfg?.host === 'string' ? cfg.host.trim() : '';
    const port = typeof cfg?.port === 'string' ? cfg.port : '';
    const username = typeof cfg?.username === 'string' ? cfg.username : '';
    // Password may legitimately be blank (e.g. an anonymous FTP login); a reopened
    // case sends the redacted sentinel, which we swap for the stored password.
    const password = resolvePassword(cases, caseIdOf(req), 'ftpPassword', typeof cfg?.password === 'string' ? cfg.password : '');
    if (!host || !username.trim()) {
      return res.status(400).json({ error: 'config.host and config.username are required.' });
    }
    const result = await testFtpConnection({ host, port, username, password });
    return res.json(result);
  });

  // --- SFTP (key-based, direct via ssh2) ---
  router.post('/sftp', async (req: Request, res: Response) => {
    const cfg = req.body?.config;
    const host = typeof cfg?.host === 'string' ? cfg.host.trim() : '';
    const port = typeof cfg?.port === 'string' ? cfg.port : '';
    const username = typeof cfg?.username === 'string' ? cfg.username : '';
    // A reopened case sends no key contents; recover the persisted key by case id.
    const privateKey = resolveSecretFile(cases, caseIdOf(req), 'privateKey', typeof cfg?.privateKey === 'string' ? cfg.privateKey : '');
    if (!host || !username || !privateKey.trim()) {
      return res
        .status(400)
        .json({ error: 'config.host, config.username and config.privateKey are required.' });
    }
    const result = await testSftpConnection({ host, port, username, privateKey });
    return res.json(result);
  });

  // --- Cloud / AWS S3 (direct via the AWS SDK, same client the browser uses) ---
  // Credentials come from the wizard's uploaded credentials FILE (its contents are
  // posted, like the SFTP private key) or from explicit key values; resolveS3Config
  // owns that choice. A file that cannot be parsed is a FAILED TEST (200 ok:false),
  // not a malformed request — only an absent bucket/region/credentials is a 4xx.
  router.post('/cloud', async (req: Request, res: Response) => {
    const resolved = resolveS3Config(withRecoveredCloudCreds(cases, caseIdOf(req), req.body?.config));
    if (!resolved.ok) {
      if (resolved.kind === 'missing') return res.status(400).json({ error: resolved.message });
      return res.json({ ok: false, message: `Connection failed: ${resolved.message}` });
    }
    const result = await testS3Connection(resolved.config);
    return res.json(result);
  });

  return router;
}
