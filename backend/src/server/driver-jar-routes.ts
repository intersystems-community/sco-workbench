import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFile } from 'node:fs/promises';
import { join, posix as posixPath } from 'node:path';
import type { Env } from '../config/env.js';
import type { IrisServices } from '../iris/index.js';
import { putFileToIris, fileExistsInIris } from '../iris/file-ops.js';
import { toIrisError } from '../iris/normalize-error.js';
import { ValidationError } from '../iris/iris-error.js';

/**
 * Data Integration → stage a SQL source's JDBC driver JAR into the IRIS container.
 *
 *   POST /  { dbType } — ensure the driver JAR for `dbType` is present in the IRIS
 *                        container and return the in-container path to use as the
 *                        deployed GenericService's `JDBCClasspath`.
 *
 * The deployed `EnsLib.SQL.Service.GenericService` runs INSIDE IRIS and loads the
 * JDBC driver through the Java Gateway JVM. For a non-IRIS database that driver
 * JAR isn't on the gateway's default classpath, so we push it from the backend's
 * `JDBC_LIB_DIR` into the IRIS container (via the Native SDK, like file uploads)
 * and hand the agent the path to set as `JDBCClasspath`. IRIS itself needs
 * nothing staged — its driver is always on the gateway's default classpath.
 *
 * Idempotent: if the JAR is already in the container the push is skipped and the
 * path is returned as-is, so re-deploying the same (or another) pipeline is a
 * no-op after the first PostgreSQL deploy.
 *
 * Mounted under the proxy-excluded `/api/data-integration` prefix and behind the
 * `/api/*` bearer auth.
 */

/**
 * Database Type → the JDBC driver JAR (a filename in `JDBC_LIB_DIR`) the deployed
 * IRIS GenericService needs on the Java Gateway classpath. This is the single
 * source of truth for the deploy path: branch on the SPECIFIC database type, not
 * "anything that isn't IRIS", so a database type that is exposed in the UI but
 * not yet wired for deploy fails loud instead of pushing a nonexistent JAR.
 *
 *   - IRIS is mapped to `null`: it's a KNOWN type that needs no staged JAR (its
 *     driver is always on the gateway's default classpath) → no push, no classpath.
 *   - A type absent from this map is UNKNOWN → the route rejects it.
 *
 * To support another database: drop its driver JAR in `JDBC_LIB_DIR`, add one
 * entry here, and add its driver class to the frontend `DB_DRIVER_CLASS` map.
 */
const DB_DRIVER_JAR: Record<string, string | null> = {
  IRIS: null,
  PostgreSQL: 'postgresql-42.7.13.jar',
};

export function createDriverJarRouter(iris: IrisServices, env: Env): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dbType = req.body?.dbType;
      if (typeof dbType !== 'string' || !dbType.trim()) {
        throw new ValidationError('dbType (string) is required.');
      }
      if (!(dbType in DB_DRIVER_JAR)) {
        // Fail loud: an unrecognized database type must not silently deploy.
        throw new ValidationError(`Unsupported database type "${dbType}".`);
      }

      const jar = DB_DRIVER_JAR[dbType];
      // A known type with no JAR to stage (IRIS) — nothing to push, no classpath.
      if (!jar) return res.json({ ok: true, irisPath: '' });

      const irisPath = posixPath.join(env.JDBC_POSTGRESQL_DRIVER_DIR, jar);
      // Idempotent: skip the push if the JAR is already staged in the container.
      if (fileExistsInIris(iris.native, irisPath)) return res.json({ ok: true, irisPath });

      const bytes = await readFile(join(env.JDBC_LIB_DIR, jar));
      putFileToIris(iris.native, { irisPath, bytes });
      return res.json({ ok: true, irisPath });
    } catch (err) {
      return next(err instanceof ValidationError ? err : toIrisError(err, { op: 'stage JDBC driver' }));
    }
  });

  return router;
}
