import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { claudeProviderShape } from './providers.js';
import { legacyEnvHint } from './legacy-env.js';

// Load .env once, as early as possible. In Docker the values come from the
// mounted env file / compose environment; locally from a developer .env at the
// repo root (cwd) or the monorepo root one level up (when run from backend/).
// `quiet` suppresses dotenv's promotional tips in container logs.
const rootEnv = resolve(process.cwd(), '.env');
const parentEnv = resolve(process.cwd(), '..', '.env');
const envPath = existsSync(rootEnv) ? rootEnv : existsSync(parentEnv) ? parentEnv : undefined;
loadDotenv({ quiet: true, path: envPath });

const EnvSchema = z
  .object({
    // ---- Claude provider configuration ----
    // Every var for all five Claude deployment options (Anthropic Claude API,
    // Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform,
    // Microsoft Foundry) lives in config/providers.ts, beside the table that
    // decides which one an environment selects and what gets forwarded to the
    // Agent SDK subprocess. Spread in here so there is exactly one schema.
    ...claudeProviderShape,

    // ---- Server ----
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // API auth token for the browser→backend hop (SC-2603). If unset, one is
    // generated at boot (see resolveApiToken) so the default path needs no
    // configuration. The SPA receives it at runtime from GET /config.json.
    WORKBENCH_API_TOKEN: z.string().optional(),
    // Network interface the server binds. Loopback by default so the
    // out-of-the-box deployment is not exposed off-host; the Docker image sets
    // 0.0.0.0 (its published port is the boundary and the token gates the hop).
    BIND_HOST: z.string().min(1).default('127.0.0.1'),

    // Backend API origin the frontend should call, served at GET /config.json for
    // the Angular runtime config. Empty (default) = same origin, which is correct
    // for the single-image deployment. Set to the backend's public origin only
    // when the frontend is deployed separately (and enable CORS for it).
    API_BASE_URL: z.string().default(''),

    // ---- Session storage ----
    SQLITE_PATH: z.string().min(1).default('/data/workbench.sqlite'),

    // ---- Uploaded-file materialization (Data Integration) ----
    // Uploaded files are held ONLY in the backend process memory between upload
    // and materialize-into-IRIS — they are NEVER written to the app container's
    // disk, so a container restart retains no user-uploaded files (the in-memory
    // manifest is simply gone). There is deliberately no staging-dir setting.
    //
    // These two vars are directories INSIDE the user's IRIS container where the
    // files are materialized (streamed there over the Native SDK, then referenced
    // by the generated adapter config). Must be writable by the IRIS process; the
    // key dir also holds 0600 secrets. Kept in SEPARATE folders. Default to /tmp,
    // which IRIS typically clears on restart — so files must be RE-UPLOADED after
    // an IRIS restart; point these at a persistent dir to survive IRIS restarts.
    SCO_UPLOAD_CSV_DIR: z.string().min(1).default('/tmp/sco-workbench/csv'),
    SCO_UPLOAD_KEY_DIR: z.string().min(1).default('/tmp/sco-workbench/keys'),

    // ---- Agent behaviour ----
    // Termination bound: the maximum agentic turns (API round-trips) for ONE user
    // message. Without it a turn that does not converge runs until someone kills it,
    // spending provider tokens the whole way. 100 is chosen to sit well above the
    // longest real flow — create-data-pipeline generates and compiles four classes,
    // each compile a separate round-trip, plus schema checks and questions — so it
    // bounds a runaway without truncating legitimate work.
    //
    // A turn stopped by this bound is NOT silent: the SDK ends the query with result
    // subtype `error_max_turns`, which the SSE mapper already reports as an error
    // rather than a successful answer.
    //
    // NOTE this bounds the number of turns, not their content. It does not verify
    // that the loop stopped for the declared reason — validated termination is a
    // separate concern and is deliberately not claimed here.
    AGENT_MAX_TURNS: z.coerce.number().int().positive().default(100),

    // ---- IRIS connection ----
    SCO_HOST: z.string().min(1),
    SCO_WEB_PORT: z.coerce.number().int().positive().default(52773),
    SCO_SUPERSERVER_PORT: z.coerce.number().int().positive().default(1972),
    // Required, with no default: the namespace is one the user created for SCO, and
    // its name is theirs to choose. Defaulting to `SC` would let a mismatched
    // deployment boot and then read an empty instance — every page blank with no
    // error pointing at the cause. Failing at startup names the real problem.
    SCO_NAMESPACE: z.string().min(1),
    SCO_USER: z.string().min(1),
    SCO_PASSWORD: z.string().min(1),
    // Optional prefix if the Atelier API is served under a web-app path prefix.
    SCO_WEB_PREFIX: z.string().optional(),
    // ---- IRIS request resilience ----
    // Per-request timeout for the REST clients (Atelier/KPI/DeepSee); an
    // AbortController fires after this and the call surfaces IrisTimeoutError (504).
    SCO_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // Total attempts per REST request (including the first). Transient socket
    // drops and idempotent 5xx are retried up to this many times.
    SCO_HTTP_RETRIES: z.coerce.number().int().positive().default(3),
    // Upstream response timeout for the reverse proxy (scmodel/scdata/scbi/deepsee).
    SCO_PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // (The sample-data `LOAD DATA` keeps its own fixed ten-minute timeout instead of
    // either of the above — see LOAD_TIMEOUT_MS in iris/sc-data-load-ops.ts. Not
    // configurable: no set needs longer, and the IRIS gateway's own timeout would cap a
    // larger value anyway.)

    // ---- JDBC connection-test sidecar (Java) ----
    // The Data Integration "Test Connection" for a database source runs REAL JDBC
    // via a small Java helper. `JAVA_BIN` is the java executable (on PATH by
    // default); `JDBC_LIB_DIR` holds the JDBC driver JAR(s) put on the classpath.
    // Both have image defaults; when Java/JARs are absent the test degrades to a
    // clear "Java not available" message rather than failing to boot.
    JAVA_BIN: z.string().min(1).default('java'),
    JDBC_LIB_DIR: z.string().min(1).default('/app/backend/jdbc-lib'),
    // ---- SQL adapter: non-IRIS driver JAR staged into the IRIS container ----
    // When a SQL pipeline targets a non-IRIS database (e.g. PostgreSQL), the
    // deployed EnsLib.SQL.Service.GenericService runs inside IRIS and needs that
    // database's JDBC driver JAR on the Java Gateway classpath. At Deploy the
    // backend pushes the JAR (from JDBC_LIB_DIR) into the IRIS container here and
    // sets this path as the service's JDBCClasspath. This is the target directory
    // INSIDE the IRIS container (default: IRIS's own Java lib dir). Users normally
    // do NOT change this — override only if the IRIS install keeps its Java libs
    // elsewhere or that dir isn't writable by the IRIS process. The IRIS driver is
    // always on the gateway's default classpath, so nothing is staged for IRIS.
    JDBC_POSTGRESQL_DRIVER_DIR: z.string().min(1).default('/usr/irissys/dev/java/lib'),

    // ---- Example (sample) data sets ----
    // Directory holding one SUBFOLDER per ready-made sample data set (each a set
    // of CSVs); the "Load sample data" page lists those folder names. Left EMPTY
    // by default, which resolves to the repo's own `SampleData/` beside the backend
    // package (see util/sample-data.ts) so a dev checkout works with no config.
    // Point it elsewhere in a container where the folder is mounted at another path.
    SAMPLE_DATA_DIR: z.string().default(''),
  });

export type Env = z.infer<typeof EnvSchema>;

// The provider-aware AI capability check, the provider resolution and the
// subprocess env are all defined in config/providers.ts. Re-exported here
// because `config/env.js` is the import every call site already reaches for, and
// splitting the imports would only make the seam noisier.
export {
  aiConfigured,
  providerEnv,
  resolveProvider,
  describeProvider,
  missingConfigHint,
  PROVIDERS,
  PROVIDER_IDS,
  type ClaudeProviderId,
  type ProviderStatus,
} from './providers.js';

let cached: Env | null = null;

/**
 * Parse and validate process.env. Fails fast with a readable message listing
 * every problem, so a misconfigured container never limps along silently.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  // Checked FIRST: a leftover IRIS_* name is the likeliest cause of a missing
  // required value, and for a defaulted setting it would otherwise be ignored in
  // silence. See config/legacy-env.ts.
  const legacy = legacyEnvHint(process.env);
  if (legacy) throw new Error(legacy);
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

