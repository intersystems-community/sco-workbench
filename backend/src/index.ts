import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnv } from './config/env.js';
import { openDatabase } from './db/sqlite.js';
import { createIrisServices } from './iris/index.js';
import { createApp } from './server/app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDatabase(env.SQLITE_PATH);
  const iris = createIrisServices(env);

  // In the single Docker image the built frontend lives next to the backend dist.
  const here = dirname(fileURLToPath(import.meta.url));
  const frontendDir = resolve(here, '..', 'public');

  const app = createApp({ env, iris, db, frontendDir });

  const server = app.listen(env.PORT, env.BIND_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`SCO Workbench agent listening on ${env.BIND_HOST}:${env.PORT} (SCO ns ${env.SCO_NAMESPACE} @ ${env.SCO_HOST})`);
  });

  const shutdown = () => {
    server.close();
    iris.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
