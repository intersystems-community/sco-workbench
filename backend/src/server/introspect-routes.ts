import { Router, type Request, type Response } from 'express';
import { fetchJdbcSchemas, fetchJdbcTables, fetchJdbcColumns } from '../util/jdbc-metadata.js';
import { parseCsv, PREVIEW_ROWS } from '../util/csv-inspect.js';
import { SftpFileSystem, type SftpBrowseConfig } from '../util/remote-fs/sftp-fs.js';
import { FtpFileSystem, type FtpBrowseConfig } from '../util/remote-fs/ftp-fs.js';
import { S3FileSystem, type S3Config } from '../util/remote-fs/s3-fs.js';
import { resolveS3Config } from '../util/aws-credentials.js';
import type { RemoteFileSystem } from '../util/remote-fs/types.js';
import type { IntegrationCaseRepository } from '../db/integration-cases.js';
import { resolvePassword, resolveSecretFile, withRecoveredCloudCreds } from './di-secret-resolver.js';
import { decryptBytes } from '../util/crypto-secret.js';

/**
 * REST routes for Data Integration source INTROSPECTION — reading the structure
 * of a connected source so the Data Entity step can populate its pickers from the
 * real server. The SQL (JDBC) source drills schema → table → column:
 *
 *   POST /api/data-integration/introspect/sql/schemas   JDBC schemas — live
 *   POST /api/data-integration/introspect/sql/tables    JDBC tables  — live
 *   POST /api/data-integration/introspect/sql/columns   JDBC columns — live
 *
 * The SFTP/FTP/S3 sources browse remote directory trees and preview CSV files as
 * RAW rows (no header interpretation — that is added in Part 2):
 *
 *   POST /api/data-integration/introspect/sftp/list     remote dir listing — live
 *   POST /api/data-integration/introspect/sftp/preview  CSV raw-row preview — live
 *   POST /api/data-integration/introspect/ftp/list      FTP dir listing — live
 *   POST /api/data-integration/introspect/ftp/preview   FTP raw-row preview — live
 *   POST /api/data-integration/introspect/s3/list        S3 dir listing — live
 *   POST /api/data-integration/introspect/s3/preview     S3 raw-row preview — live
 *   POST /api/data-integration/introspect/local/preview  local CSV text → raw rows
 *
 * Kept separate from the "Test Connection" router (connection-test-routes.ts):
 * that one answers "can we connect?", this one answers "what's in there?". Both
 * live under the /api/data-integration prefix, which is excluded from the IRIS
 * proxy via LOCAL_API_PREFIXES so it reaches Express.
 *
 * A COMPLETED fetch always returns 200 with { ok, ... } — a failed *fetch*
 * (unreachable host, bad credentials) is a normal result the UI renders, not an
 * HTTP error. Only a malformed request body is a 4xx. Passwords/keys are used
 * server-side only and never logged.
 */

/**
 * Constructors the router uses to build a RemoteFileSystem per request. Injectable
 * so route tests can pass a fake filesystem and assert the raw-row wiring without a
 * live server. Defaults are the real transport classes, so app.ts calls
 * createIntrospectRouter() with no arguments.
 */
export interface FileSystemFactories {
  sftp: (config: SftpBrowseConfig) => RemoteFileSystem;
  ftp: (config: FtpBrowseConfig) => RemoteFileSystem;
  s3: (config: S3Config) => RemoteFileSystem;
}

const defaultFactories: FileSystemFactories = {
  sftp: (config) => new SftpFileSystem(config),
  ftp: (config) => new FtpFileSystem(config),
  s3: (config) => new S3FileSystem(config),
};

export function createIntrospectRouter(
  factories: FileSystemFactories = defaultFactories,
  cases?: IntegrationCaseRepository,
): Router {
  const router = Router();

  /** A reopened case carries its id INSIDE the introspection config (these configs
   *  never feed the Test Connection signature), so the handlers can recover a
   *  persisted secret the browser holds only redacted. */
  const caseIdOf = (cfg: unknown): string | undefined => {
    const id = (cfg as { caseId?: unknown } | null | undefined)?.caseId;
    return typeof id === 'string' && id.trim() ? id.trim() : undefined;
  };

  /** Pull + validate the shared JDBC connection config from the request body. */
  const readConfig = (req: Request) => {
    const cfg = req.body?.config;
    const dsn = typeof cfg?.dsn === 'string' ? cfg.dsn.trim() : '';
    const username = typeof cfg?.username === 'string' ? cfg.username : '';
    // A reopened case sends the redacted sentinel; swap in the stored password.
    const password = resolvePassword(cases, caseIdOf(cfg), 'dbPassword', typeof cfg?.password === 'string' ? cfg.password : '');
    const driverClass = typeof cfg?.driverClass === 'string' ? cfg.driverClass.trim() : '';
    return { dsn, username, password, driverClass, valid: !!(dsn && username && driverClass) };
  };
  const configError = { error: 'config.dsn, config.username and config.driverClass are required.' };

  // --- SQL / JDBC: list the database's schemas ---
  router.post('/sql/schemas', async (req: Request, res: Response) => {
    const c = readConfig(req);
    if (!c.valid) return res.status(400).json(configError);
    const result = await fetchJdbcSchemas(c);
    return res.json(result);
  });

  // --- SQL / JDBC: list the tables/views in a schema ---
  router.post('/sql/tables', async (req: Request, res: Response) => {
    const c = readConfig(req);
    if (!c.valid) return res.status(400).json(configError);
    const schema = typeof req.body?.schema === 'string' ? req.body.schema.trim() : '';
    if (!schema) return res.status(400).json({ error: 'schema is required.' });
    const result = await fetchJdbcTables(c, schema);
    return res.json(result);
  });

  // --- SQL / JDBC: list a table's columns (name + data type) ---
  router.post('/sql/columns', async (req: Request, res: Response) => {
    const c = readConfig(req);
    if (!c.valid) return res.status(400).json(configError);
    const schema = typeof req.body?.schema === 'string' ? req.body.schema.trim() : '';
    const table = typeof req.body?.table === 'string' ? req.body.table.trim() : '';
    if (!schema || !table) return res.status(400).json({ error: 'schema and table are required.' });
    const result = await fetchJdbcColumns(c, schema, table);
    return res.json(result);
  });

  /** Run a bounded preview and reply with RAW rows (Part 1 — no inspection). */
  const previewRaw = async (fs: RemoteFileSystem, path: string, res: Response) => {
    const pv = await fs.readPreview(path);
    return res.json(pv);
  };

  /** Pull + validate the shared SFTP connection config (key used server-side only). */
  const readSftpConfig = (req: Request) => {
    const cfg = req.body?.config;
    const host = typeof cfg?.host === 'string' ? cfg.host.trim() : '';
    const port = typeof cfg?.port === 'string' ? cfg.port : '';
    const username = typeof cfg?.username === 'string' ? cfg.username : '';
    // A reopened case sends no key contents; recover the persisted key by case id.
    const privateKey = resolveSecretFile(cases, caseIdOf(cfg), 'privateKey', typeof cfg?.privateKey === 'string' ? cfg.privateKey : '');
    return { host, port, username, privateKey, valid: !!(host && username && privateKey.trim()) };
  };
  const sftpConfigError = { error: 'config.host, config.username and config.privateKey are required.' };

  // --- SFTP: list a remote directory (folders + CSV/other files) ---
  router.post('/sftp/list', async (req: Request, res: Response) => {
    const c = readSftpConfig(req);
    if (!c.valid) return res.status(400).json(sftpConfigError);
    const path = typeof req.body?.path === 'string' ? req.body.path : '/';
    const result = await factories.sftp(c).listDir(path);
    return res.json(result);
  });

  // --- SFTP: preview a remote CSV (raw rows, header-agnostic) ---
  router.post('/sftp/preview', async (req: Request, res: Response) => {
    const c = readSftpConfig(req);
    if (!c.valid) return res.status(400).json(sftpConfigError);
    const path = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!path) return res.status(400).json({ error: 'path is required.' });
    return previewRaw(factories.sftp(c), path, res);
  });

  /** Pull + validate the plain-FTP browse config. */
  const readFtpConfig = (req: Request) => {
    const cfg = req.body?.config;
    const host = typeof cfg?.host === 'string' ? cfg.host.trim() : '';
    const port = typeof cfg?.port === 'string' ? cfg.port : '';
    const username = typeof cfg?.username === 'string' ? cfg.username : '';
    // A reopened case sends the redacted sentinel; swap in the stored password.
    const password = resolvePassword(cases, caseIdOf(cfg), 'ftpPassword', typeof cfg?.password === 'string' ? cfg.password : '');
    return { host, port, username, password, valid: !!(host && username.trim()) };
  };
  const ftpConfigError = { error: 'config.host and config.username are required.' };

  router.post('/ftp/list', async (req: Request, res: Response) => {
    const c = readFtpConfig(req);
    if (!c.valid) return res.status(400).json(ftpConfigError);
    const path = typeof req.body?.path === 'string' ? req.body.path : '/';
    return res.json(await factories.ftp(c).listDir(path));
  });

  router.post('/ftp/preview', async (req: Request, res: Response) => {
    const c = readFtpConfig(req);
    if (!c.valid) return res.status(400).json(ftpConfigError);
    const path = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!path) return res.status(400).json({ error: 'path is required.' });
    return previewRaw(factories.ftp(c), path, res);
  });

  /**
   * Pull + validate the S3 browse config (keys used server-side only). Accepts
   * EITHER explicit key values or the contents of the wizard's uploaded AWS
   * credentials file — resolveS3Config (util/aws-credentials.ts) owns that choice,
   * and it is the same resolver the cloud Test Connection route uses, so a
   * connection that tests OK is exactly one that can browse.
   */
  router.post('/s3/list', async (req: Request, res: Response) => {
    const c = resolveS3Config(withRecoveredCloudCreds(cases, caseIdOf(req.body?.config), req.body?.config));
    // A missing field is a malformed request (4xx); credentials that ARE present
    // but unreadable are a normal failed listing the UI renders inline.
    if (!c.ok) {
      return c.kind === 'missing'
        ? res.status(400).json({ error: c.message })
        : res.json({ ok: false, message: `Listing failed: ${c.message}` });
    }
    const path = typeof req.body?.path === 'string' ? req.body.path : '/';
    return res.json(await factories.s3(c.config).listDir(path));
  });

  router.post('/s3/preview', async (req: Request, res: Response) => {
    const c = resolveS3Config(withRecoveredCloudCreds(cases, caseIdOf(req.body?.config), req.body?.config));
    if (!c.ok) {
      return c.kind === 'missing'
        ? res.status(400).json({ error: c.message })
        : res.json({ ok: false, message: `Preview failed: ${c.message}` });
    }
    const path = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!path) return res.status(400).json({ error: 'path is required.' });
    return previewRaw(factories.s3(c.config), path, res);
  });

  // --- Local: parse bounded CSV text the browser already read (no transport) ---
  router.post('/local/preview', (req: Request, res: Response) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'text is required.' });
    return res.json({ ok: true, rows: parseCsv(text, PREVIEW_ROWS) });
  });

  // --- Local: preview a REOPENED case's persisted data file (raw rows) ---
  // A fresh local preview reads the picked File in the browser (local/preview above),
  // but after a refresh the browser no longer holds that File — the bytes live only
  // in SQLite. So a reopened case previews from the stored copy by case id, mirroring
  // how the SQL/FTP/SFTP/S3 restores recover their persisted secret server-side. A
  // missing slot is a normal outcome the UI renders inline (200 ok:false), not a 4xx.
  router.post('/local/preview-stored', (req: Request, res: Response) => {
    const caseId = typeof req.body?.caseId === 'string' ? req.body.caseId.trim() : '';
    const slot = typeof req.body?.slot === 'string' && req.body.slot.trim() ? req.body.slot.trim() : 'localFile';
    if (!caseId) return res.status(400).json({ error: 'caseId is required.' });
    if (!cases) return res.json({ ok: false, message: 'Case store is not available.' });
    const stored = cases.getFileBytesBySlot(caseId, slot);
    if (!stored) return res.json({ ok: false, message: 'No stored file for this case; re-upload it to preview.' });
    const raw = stored.encrypted ? decryptBytes(stored.bytes) : stored.bytes;
    return res.json({ ok: true, rows: parseCsv(raw.toString('utf8'), PREVIEW_ROWS) });
  });

  return router;
}
