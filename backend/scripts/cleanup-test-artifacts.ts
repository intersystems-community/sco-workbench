/**
 * CLI: remove all temporary Workbench.Test.* artifacts from IRIS.
 * Usage:  npm run cleanup:test
 *
 * Reads IRIS connection from .env (same as the server). Only touches the
 * Workbench.Test package, the test cube, and the test production.
 */
import { loadEnv } from '../src/config/env.js';
import { createIrisServices } from '../src/iris/index.js';
import { cleanupTestArtifacts } from '../src/iris/test-cleanup.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const iris = createIrisServices(env);
  // eslint-disable-next-line no-console
  console.log(`Cleaning Workbench.Test.* artifacts from IRIS ns ${env.SCO_NAMESPACE} @ ${env.SCO_HOST}…`);
  try {
    const log = await cleanupTestArtifacts(iris);
    for (const line of log) {
      // eslint-disable-next-line no-console
      console.log(`  • ${line}`);
    }
    // eslint-disable-next-line no-console
    console.log('Cleanup complete.');
  } finally {
    iris.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Cleanup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
