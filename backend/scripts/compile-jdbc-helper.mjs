// Compile the JDBC helpers (jdbc-helper/*.java) for local `npm run dev`.
//
// In Docker the Dockerfile compiles this with a JDK; locally we compile it here
// so the backend can spawn it. If `javac` isn't installed, this is a NO-OP (exit
// 0) — the JDBC Test Connection then degrades to a clear "Java not available"
// message instead of breaking `npm run dev`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const helperDir = resolve(here, '..', 'jdbc-helper');

const probe = spawnSync('javac', ['-version'], { stdio: 'ignore' });
if (probe.error) {
  console.log('[compile-jdbc-helper] javac not found — skipping (JDBC test will report "Java not available").');
  process.exit(0);
}

// Compile every helper (.java) — TestJdbc, JdbcSchemas, …
const sources = readdirSync(helperDir).filter((f) => f.endsWith('.java'));
// -encoding UTF-8 is required: the sources have non-ASCII characters in comments,
// and javac otherwise reads them in the platform charset. That is UTF-8 on a dev
// Mac but US-ASCII in the CI container, where every one becomes an "unmappable
// character" error (57 of them) and no .class is produced.
const res = spawnSync('javac', ['-encoding', 'UTF-8', ...sources], { cwd: helperDir, stdio: 'inherit' });
if (res.status === 0) {
  console.log(`[compile-jdbc-helper] compiled ${sources.join(', ')}`);
} else {
  console.log('[compile-jdbc-helper] compile failed — JDBC test/schema fetch may not run locally.');
}
// Never fail the dev startup on this.
process.exit(0);
