# Integration Test Standard

This is the reference for how we write and run backend integration tests against InterSystems IRIS.
It captures the *principles* and *coverage areas* — not an exhaustive case list (the tests themselves
are the source of truth). Read this before adding a new suite so it fits the same standard.

## Why we test against live IRIS

The backend talks to IRIS over several channels, each with its own request/response and error shape:

- **Atelier REST + SQL** — source import/compile, `%Dictionary` introspection
- **Native SDK** — `%DeepSee.Utils`, `Ens.*`, `%Status` decoding (superserver port)
- **SCO scbi KPI REST** — Business KPI CRUD
- **DeepSee D2CLIENT** — read-only cube structure
- **Reverse proxy** — scmodel / scdata / scbi / deepsee forwarded to IRIS with server-injected auth

Mocks can't faithfully reproduce IRIS envelope quirks (`%Status`, compiler console output, SCO
`{Status, Message}` bodies, MDX runtime errors). So **integration tests always run against a live IRIS**.
Error-injection cases a live instance can't produce on demand (malformed JSON, HTML 500 bodies, forced
timeouts, connection-refused) are covered at the **unit** level instead, using the `fetch` global-stub
and `ConnectionFactory` seams.

## The clean-IRIS baseline

Every integration test assumes a **freshly installed SCO instance and nothing more**:

- Default SCO cubes exist (`SC.Core.Analytics.Cube.*`) and the default SCO data model exists
  (`SC.Data.SalesOrder`, its `*ApiImpl` classes).
- **No** user KPIs, **no** custom (Workbench) cubes, **no** custom data-model objects.
- SQL tables **may be empty** — never assume any table has rows.

A test that needs data, a cube, or a KPI **provisions it itself** and references only what it created.
A KPI points at a Workbench cube the same test built — never at populated SCO data.

## Core principles

1. **Self-provisioning.** Each test seeds its own persistent class + rows, builds its own cube, creates
   its own KPI. No test depends on pre-existing user data.
2. **Independent & order-free.** No test relies on another test's state. Any single test can run alone,
   and the whole suite can run twice back-to-back with identical results (idempotent).
3. **Run-unique names.** Artifacts are named with a per-run stamp (`WORKBENCH_IT_STAMP`) + a per-test
   counter so repeat or parallel runs never collide. Everything lives under the `Workbench.Test.*`
   package for one-shot wildcard cleanup.
4. **Never leave IRIS dirty.** Cleanup runs in `afterEach` inside a `try/finally`-safe, idempotent,
   tolerant helper — deleting a nonexistent artifact is a no-op, and a *failed* test still triggers full
   teardown. A global `afterAll` sweep removes the entire `Workbench.Test.*` package as a backstop in
   case a teardown itself failed mid-way.
5. **Non-invasive.** Tests never stop or modify a production the user already has running; they only
   start a throwaway production if none is active, and stop it afterward.
6. **Test the failure paths, not just the happy path.** Every backend `catch`/error branch, every
   validation rule, and every user-facing dropdown value should be exercised. Invalid input and messy
   multi-step workflows are where the reliability payoff is.

> Note: the SCO `scmodel` API is **create-only** (no delete). Custom objects created by a test use a
> unique per-run name and are treated as disposable — the sweep can't remove them, but unique naming
> prevents cross-run collisions. Treat the IRIS test target as disposable.

## Test the hard cases — this is the point of the suite (READ THIS)

Happy-path tests are the *least* valuable thing here. A "create a cube, it works" test tells us almost
nothing. **The reliability payoff — and most of the real bugs, in our code AND in SCO — come from the
negative, invalid, and messy cases.** When you add or extend a suite, spend the majority of your effort
here, not on the happy path.

For **every** feature, deliberately try to break it. Ask:

1. **Invalid input at every field.** Blank/missing required fields, wrong types, values outside the
   allowed set, and — critically — values our validation *lets through* that only fail deep in IRIS.
   Assert the exact error (status + code + message), not just "it errored."
2. **Every dropdown value must actually work in IRIS.** Don't assume the options we offer are valid.
   Data-drive a test over each enum value (aggregate, measure type, dimension type, time function,
   data type) and compile/build it for real. A value IRIS rejects is a defect in our dropdown or
   generator — the test should catch it.
3. **Malformed domain input that reaches IRIS unchecked** — bad MDX in KPI conditions, invalid
   ObjectScript in a cube expression, a source property that doesn't exist, a cube name that isn't a
   valid identifier. These pass our validation and surface only at compile/query time.
4. **Failure & boundary states** — IRIS unreachable, empty tables, zero rows, not-found, duplicate
   create, read-only/built-in guard, auth failure. Assert the typed error envelope.
5. **Messy multi-step user workflows** — rename, re-save after build, name collisions with built-ins,
   compile-succeeds-but-build-fails, create-then-recreate. These expose state-divergence bugs a single
   operation never would.
6. **Cover every backend `catch`/error branch.** If a route or client has an error path, there should
   be a test that drives it. An untested `catch` is an untested behavior.

### Finding SCO bugs is a feature, not a distraction

Because these tests exercise the real SCO APIs over the wire, a thorough negative test frequently
uncovers a genuine SCO defect (an unhandled error, a 500 where a 400 belongs, a silent wrong result).
**When that happens:** reproduce it in isolation (a small script or Postman), read the SCO class source
in the IRIS container to confirm the mechanism (`find / -iname "<Class>*.cls"` under the ipm source
tree), ask the user if he wants to file a Jira in the **SC** project, and make the test **document the current (buggy) behavior**
with a comment citing the ticket — so it stays green now and fails loudly (prompting an update) when
the fix ships. Example precedent: **SC-2643** (`scbi/v1/kpi/values/{name}` returns 500 `<INVALID OREF>`
for malformed MDX instead of 400) was found exactly this way, from KPI test KI7.

### Worked example — a cube-measure test done RIGHT vs. WRONG

```ts
// ❌ WRONG — happy path only; proves almost nothing, hides real behavior.
it('builds a cube with a SUM measure', async () => {
  const cube = await buildTestCube(iris, src);
  expect(cube.factCount).toBeGreaterThan(0);
});

// ✅ RIGHT — the same feature, but the hard cases that actually find bugs:
it('CI6: an aggregate outside SUM/COUNT/AVG/MIN/MAX passes our validation but 422s at IRIS compile', ...);
it('CI10: a level sourceProperty that does not exist on the source class 422s at compile', ...);
it('every AGGREGATES dropdown value compiles + builds in IRIS (data-driven over the enum)', ...);
it('IRIS rejects SUM on a boolean measure — surfaced as a clean typed 422, not a crash', ...);
it('a cube name with a space/dot is rejected with a 400 before it can mis-target a class', ...);
```

The right version documents a real SCO constraint (aggregate/type pairing), proves the dropdown is
honest, and pins the failure contract — none of which the happy-path test does.

### Guardrails when writing the negative cases

- **Match how the product actually builds things.** A KPI must use a real cube measure and a real MDX
  member condition (not `%COUNT`/`%ALL` placeholders) or the value endpoint fails for reasons unrelated
  to what you're testing. Build the invalid case *on top of* a valid one so the negative is isolated.
- **Assert the specific failure, not just "not 200."** Check the HTTP status, the `code` in the error
  envelope, and the message/`details` — a test that only checks "≥ 400" can pass for the wrong reason.
- **Don't over-assert side effects you can't control.** DeepSee cube build/kill churn within one process
  can leave the engine unable to `%PrepareMDX` a later cube — so a suite that kills cubes between tests
  cannot reliably assert a *working* KPI value afterward. Assert the failure contract you care about,
  and keep value-query success out of suites that churn cubes.

## Coverage areas

Per-feature suites live under `backend/test/integration/`; cross-component flow suites live under
`backend/test/e2e/`. Each area covers happy paths **and** the failure/invalid matrix for that feature.

| Area | What it covers |
|---|---|
| **Schema** | Atelier SQL introspection: SQL-table→class resolution, property/method listing, typo→closest-match, unknown-class candidates |
| **Cube** | Full lifecycle: save (draft) → compile → build → detail → definition → delete; read-only guard for SCO built-ins; empty-table build |
| **Cube — invalid** | Validation 400s (exact messages) and IRIS compile 422s: bad aggregate, invalid dimension/measure type, nonexistent source property, bad ObjectScript expression, unknown source class, build failure |
| **Cube — enums** | Every dropdown value (aggregates, measure/dimension types, time functions, listing types) round-trips through IRIS. A value IRIS rejects is a defect — the dropdown or generator is aligned |
| **Cube — workflows** | State-divergence sequences: re-save after build, rename to a failing def, name collisions with SCO built-ins, dotted/spaced names, compile-ok-build-fail recovery |
| **KPI** | CRUD via the scbi proxy and the agent KPI client; full-field percentage round-trip; drafts save/rename/delete; base-object listing |
| **KPI — invalid** | Validation messages, duplicate-create conflict, invalid MDX in conditions (fails at IRIS runtime), severity/status bounds, nonexistent cube |
| **KPI — workflows** | Draft-vs-real-KPI name collisions, rename overwrite/stale-draft cases |
| **Data Model** | scmodel list/detail/create/add-attribute (create-only); duplicate-create rejection; row counts (including empty and unknown-class 404) |
| **Data Model — invalid** | Re-create, duplicate attribute, attribute on nonexistent object, invalid dataType — asserting the IRIS `Message` surfaces (regression guard for the capital-`M` casing bug) |
| **Proxy / auth** | SCO `{Status, Message}` byte-faithful passthrough, paging-header exposure, auth-failure surfacing, `/healthz` reachability |
| **E2E / multi-component flows** (`test/e2e`) | The cross-component chain **custom object → cube → KPI → data load → query** over both a custom scmodel object (exact clean-state `factCount` + KPI value) and the real `SC.Data.SalesOrder` (read-only: build succeeds + numeric value). Emphasis on **seam failures**: wrong property/measure names, KPI-before-cube, wrong-typed data load, query-after-cube-delete, malformed MDX. Value-asserting golden paths build exactly one cube per file for stability. |

## Error-handling contract under test

The backend maps all IRIS failures into a typed error taxonomy and a single response envelope:

```jsonc
{ "error": { "code": "SCO_UNREACHABLE" | "SCO_TIMEOUT" | "COMPILE_FAILED" | ..., "message": "<friendly>", "details": <optional> } }
```

Backend-owned routes (`/api/cubes`, `/api/kpi-drafts`, `/api/data-browser`) produce this envelope with a
correct HTTP status (400/403/404/409/422/500/502/504). Proxied routes (`scmodel`/`scdata`/`scbi`) pass
IRIS's own body/status through untouched (and synthesize the same envelope only when IRIS is
unreachable). Tests assert the code + status + `details` for each failure class.

## Running the tests

Three tiers, each selected by a **vitest project** (there is **no `RUN_IRIS_IT` env flag** — the script/path
is the only selector):

```bash
npm run test:unit   # unit tests, no IRIS required (also the default `npm test` / bare `vitest run`)
npm run test:it     # live INTEGRATION tests against IRIS — test/integration (per feature)
npm run test:e2e    # live E2E tests against IRIS — test/e2e (multi-component flows)
```

- The tiers are vitest `projects` in `vitest.config.ts` (`unit` → `test/unit`, `integration` →
  `test/integration`, `e2e` → `test/e2e`). The scripts pass `--project unit|integration|e2e`. A bare
  `npm test` / `vitest run` runs **unit only**, so nothing touches IRIS by default.
- Two further projects are opt-in and are NOT run by CI's per-MR jobs: `live-source` (see below) and
  `agent-eval` → `test/agent-eval`, `npm run test:agent-eval`, which scores real agent turns and so
  needs Bedrock credentials as well as a live instance. An opt-in tier gets its own project rather
  than an env-gated `.skip`, because `assert-test-files.mjs` fails any tier reporting a skipped test.
- The live tiers need a live IRIS reachable via `.env` (`SCO_HOST`, `SCO_USER`, `SCO_PASSWORD`,
  namespace `SC`).
- Suites run **sequentially**, not in parallel workers (`fileParallelism: false`). They share one live
  IRIS and the `Workbench.Test.*` namespace, so parallel files would let one suite's cleanup wipe
  another's in-flight artifacts. Unit tests are unaffected (fast, no shared state).
- **Isolation check:** run a single file alone, e.g.
  `npx vitest run --project integration test/integration/kpi.it.test.ts` — it must pass without any other
  suite having run first.
- **Idempotency check:** run `npm run test:it` (or `test:e2e`) twice back-to-back — no leftover state.
- Manual cleanup at any time: `npm run cleanup:test`.

### If every `/api/*` request starts returning 503

Accumulated CSP sessions have exhausted the licence. Clear them in `%SYS`:

```objectscript
do ##class(%CSP.Session).%DeleteExtent()
```

Every route recovers immediately; the only cost is logging out open browser sessions. Restarting IRIS
also works — restarting the **Web Gateway does not**, because the sessions are held on the IRIS side.

The limit is connections **within one licence unit**, not licence units, so
`$SYSTEM.License.ShowSummary()` is misleading: it reports units to spare (2 of 8) while the bucket is
full. All workbench calls authenticate as the same user from the same Docker host IP, so they share
one bucket that caps at **25 connections**. Verified 2026-09-03 on the community-edition image: 25
sequential authenticated `GET /api/atelier/v1/SC` calls succeed and the 26th returns 503, and from
then on `/api/atelier`, `/api/SC/scmodel/v1` and `/api/SC/scbi/v1` all 503 while `/csp/sys` still
returns 200 and the applications are still `Enabled=1`. The 503 is IRIS's own (it sets a
`CSPSESSIONID` cookie and sends no `Date` header) and `messages.log` logs `License limit exceeded`.

Running `test:it` and `test:e2e` back-to-back against one instance can reach the cap mid-run; each
tier passes on its own. CI does not hit it — every job gets its own instance.

## Running in CI

`.gitlab-ci.yml` runs both live tiers on every merge request, blocking, in the `live-test` stage:

| Job | Script | Tier |
|---|---|---|
| `live-integration-test` | `test:it:ci` | `test/integration/**/*.it.test.ts` |
| `live-e2e-test` | `test:e2e:ci` | `test/e2e/**/*.e2e.test.ts` |

So "all applicable tiers must pass" is now machine-checked, not honour-system.

- **Each job stands up its own ephemeral IRIS + Web Gateway** inside docker-in-docker from
  sc-framework's community-edition image (`ci/iris/`), then throws it away. Treat the IRIS test target
  as disposable — CI already does. The two tiers must not share an instance: `sweep.ts` deletes
  instance-wide by prefix, and see the 503 note above.
- **The CI baseline is cleaner than any dev instance:** SCO classes and web apps, but no generated
  data, no running production, and no built default cubes. That is why "SQL tables may be empty" is a
  hard rule — a test that assumes rows exist passes locally and fails in CI.
- **A `.skip` fails the job.** The `*:ci` scripts wrap vitest in `ci/assert-test-files.mjs`, which
  diffs the collected file set against `git ls-files` and requires
  `numPassedTests === numTotalTests`. There is no skip escape hatch.
- `iris-messages.log` is saved as an artifact on every run, red or green — licence errors, auth
  rejections and compile errors all land there.
- `node ci/wait-for-iris.mjs` is a hard preflight before the tier runs, because `globalSetup` is
  tolerant of a missing IRIS and would otherwise surface the problem as an unrelated red test many
  minutes later. It is useful locally too:
  `SCO_HOST=localhost SCO_WEB_PORT=52773 node ci/wait-for-iris.mjs`.

## The real-source tier (`test/live-source`)

A fourth tier, `npm run test:live` / `test:live:ci`, job `live-source-test`. It is the **only** tier
that reaches outside the runner: a real S3 bucket plus an EC2 box running sshd, vsftpd and
PostgreSQL.

**Why it exists.** No other tier proves that data actually gets ingested from any source. The unit
tier injects fakes (`ftp-test.ts`'s own comment: the fake exists "so the tests exercise every path
without a live FTP server"); `integration-generator.it.test.ts` only *compiles* the generated classes;
and `interop.it.test.ts` deploys config items but `production-ops.ts` defaults them to
`enabled: false`, so no adapter ever starts. Generation and configuration are well covered — **actual
ingestion is unproven end to end**, and FTP is worst: many unit cases, zero live ones.

**What is covered.** Four suites — `s3`, `sftp`, `ftp`, `postgres` — each one ORDERED, each walking the
whole flow a user performs through the product's own seams. Nothing is faked and no step is skipped.
The S3 suite is the exemplar; the others have the same shape plus what their protocol adds:

| Step | What it proves |
|---|---|
| F1 upload the credentials file | `POST /uploads` with `kind: 'aws-cred'` holds it for a path in the IRIS key dir and writes **nothing** to IRIS yet |
| F2–F4 Test Connection | the real S3 accepts the file; a mistyped secret and an absent bucket are 200 `{ok:false}` with distinct, pinned wording |
| F5 browse + preview | `/introspect/s3/list` types `sales.csv` as `csv`, and `/preview` returns the real header and first row |
| F6 Deploy | `/uploads/materialize` writes the credentials into the IRIS container, then the generated classes compile, the hosts register DISABLED, and the inbound service is enabled LAST |
| F7 ingestion | the enabled adapter polls S3 and the rows land in the target SCO object with their MAPPED values (`ToUpper` proves the DTL ran); `notes.txt` is excluded by `BlobNamePattern` |
| F8 steady state | a second file dropped later upserts the changed row on the key index and inserts the new one — 4 rows, not 5 |

The negative cases live in F3/F4 and they are the point: a fake cannot be trusted to reproduce what a
live endpoint says. Note that `err.message` from the AWS SDK carries only the service's human
sentence, never the error **code**, so nothing may match on `NoSuchBucket` / `SignatureDoesNotMatch`.

What each of the other three adds on top of that shape:

- **`sftp.live.test.ts`** — key-only authentication (a File-type CI variable already holds a path, so
  the key needs no staging), and a missing directory that reports "No such file" rather than an empty
  listing.
- **`ftp.live.test.ts`** — two different clients against one server (`basic-ftp` for the wizard,
  `EnsLib.FTP.InboundAdapter` for the pipeline), and an explicit **passive-mode** check: the suite
  reads the server's 227 reply and fails with a named mismatch if the advertised port is outside the
  declared range or the advertised address is not the one the control connection used. Unlike SFTP, an
  FTP `LIST` of a path that does not exist is a successful EMPTY listing, so browse cannot tell a
  missing directory from an empty one — documented, not asserted as good.
- **`postgres.live.test.ts`** — the `SQL` adapter against a genuinely non-IRIS database: driver-JAR
  staging (`postgresql-42.7.13.jar` into the IRIS container, then set as `JDBCClasspath`),
  `org.postgresql.Driver`, schema/table/column introspection, and the row-tracking semantics of
  `EnsLib.SQL.InboundAdapter` — with `KeyFieldName` set and no `DeleteQuery`, an UPDATE to an
  already-processed key is **never** re-ingested; only a new key is. It is also the only suite that
  needs a **JDK in the job container**: the SQL Test Connection and schema browse spawn
  `backend/jdbc-helper/*.class`, and only the `.java` files are tracked (CI step 7c).

**Three things these suites found that no fake could.**

1. **The FTP adapter's MLSD trap.** `EnsLib.FTP.Common.MLSD` is "Not supported by all servers", and on
   vsftpd (no MLST in FEAT) `OnInit` hard-fails with `ERROR #5001: MLSD set but not supported by FTP
   server.` Worse, MLSD switches `FileSpec` from a wildcard to a **regex**, so `*.csv` becomes
   `ERROR #8311: Syntax error in regexp pattern`. The generator no longer sets it.
2. **A PostgreSQL `text` column cannot be ingested at all.** The pipeline fails with
   `ERROR #5023: Remote Gateway Error: JDBC Gateway getClob(0,1) error Remote JDBC error: Bad value for
   type long`. The driver reports a `text` column's precision as 2147483647 and
   `EnsLib.SQL.GatewayResultSet.%isLOB` therefore classifies it as a LOB, which is fetched with
   `getClob()` — implemented by the PostgreSQL driver only for OID large objects. No
   `MaxVarCharLengthAsString` value avoids it: `%isLOB` caps that value at `$$$MaxStringLength` before
   comparing. The only workaround is a narrower source type, so the fixture uses `varchar(n)` and keeps
   one `text` column solely so Q11 can pin the failure. Filed as **SC-2717**.
3. **`Ens.Director` cannot gracefully stop a running job over the Native SDK.** `Ens.Job.Stop` locks
   `^Ens.JobRequest`, sets the terminate request, releases the lock, signals the job, then waits for
   the job's `^Ens.JobLock`. Driven from the SDK the release never takes effect — the calling process
   is inside a transaction (`%SYS.ProcessQuery.InTransaction` is non-zero for it and zero for an
   ordinary SDK call) and IRIS defers `LOCK -` to commit — so the job blocks on the retained lock and
   the wait ends in `ERROR <Ens>ErrJobNotStopped: Job 'N' failed to stop within N seconds`. The
   identical call from an IRIS terminal succeeds in ~10ms. With `production-ops.ts`'s 15/25/35s
   retries, every config-item operation costs ~85s and the job still does not stop.
   `UpdateProduction(timeout, force=1)` does work, because `Ens.Job.Stop`'s force branch terminates
   the process outright — so `forceStopDeployedHosts` (in `helpers/ingest.ts`) disables each deployed
   host *without* hot-applying and forces one reconcile as the first step of teardown, and the
   ordinary cleanups then have no running job left to stop. Adding a config item stops nothing and is
   unaffected, which is why Q11 deploys a SECOND service instead of re-pointing the first. Filed as
   **SC-2718**.

**`helpers/ingest.ts` is the deploy → enable → poll → verify core**, source-agnostic so the SFTP / FTP
/ PostgreSQL suites reuse it. Two things it must get right, both found the hard way:

- **The production it deploys onto must be the ACTIVE one, with live jobs.** `EnableConfigItem` acts on
  the active production, and `startProduction` reports IRIS's `ErrProductionAlreadyRunning` as success —
  which is what IRIS returns when a *different* production is running. It is also possible for
  `GetProductionStatus` to say Running while `Ens.Director.IsProductionRunning` says 0 (an instance
  restarted without stopping its production keeps the state and loses every job); enabling an item then
  succeeds and nothing ever polls. `ensureProduction` restarts such a production and refuses to
  continue if jobs do not come up, instead of leaving the test to time out against an empty Ens log.
- **On timeout, dump `Ens.Util.Log`.** Without it a failed ingestion says only "0 rows"; the reason (a
  bad `ProviderCredentialsFile`, a missing column) is only ever in that table.

**Ingestion needs the credentials file inside the IRIS container.**
`ProviderCredentialsFile` is a path on the IRIS host, so `/materialize` stages it there over the Native
SDK (IRIS writes the file itself — no bind mount, which is why this works inside dind). The file is
normalized to a `[default]` profile on the way in because the adapter hands it to a Java SDK that reads
only that profile; F1 uploads a NAMED profile and F2 then authenticates with it, which is what proves
the rewrite. Verified in the IRIS image: `EnsLib.AmazonS3.InboundAdapter` (a subclass of
`EnsLib.CloudStorage.InboundAdapter`, which is what the generator emits), Java 11 and
`intersystems-cloudclient-1.5.1.jar` are all present. No JavaGateway config item is needed — the
adapter's own `OnInit` sets `%remoteClassname`, `%gatewayName = "%Java Server"` and the cloud-client
classpath — but it does mean the **`%Java Server` external language server must be able to start**, so
the CI IRIS needs its JRE. `CallInterval` is 5s by default, hence the polling budget in
`waitForRows`.

**It is a separate tier, not an extension of `integration`.** These tests need credentials, so a
developer who has none must still be able to run everything else. `CLAUDE.md` treats `test:it` and
`test:e2e` as always-runnable, and that stays true.

**Configuration.** `ci/live-source.env.example` is the single reference — copy it to a gitignored
`.env.live-source` at the repo root for local runs. It also documents every GitLab CI/CD variable the
job needs and which must be **Masked** or **File** type. Credentials are deliberately kept out of
`.env` so a normal `npm run dev` cannot pick them up.

- **AWS uses STS assume-role, never a stored key.** The job assumes `$LIVE_SOURCE_S3_ROLE_ARN` with
  `$LIVE_SOURCE_S3_EXTERNAL_ID` and exports the temporary triple, so the only AWS secrets in GitLab
  are an ARN and an external id. This is the pattern `total-view-for-supply-chain` uses. Our code
  already carries a session token end to end (`aws-credentials.ts` → `resolveS3Config` → `s3-fs.ts`,
  and `normalizeAwsCredentialsToDefaultProfile` writes `aws_session_token=` into the file that becomes
  the IRIS adapter's `ProviderCredentialsFile`), so one triple serves both the Node and IRIS sides.
- **A missing variable throws in CI and skips locally.** `describeIfConfigured` in
  `test/live-source/helpers/sources.ts` enforces this. It must not skip in CI: `assert-test-files.mjs`
  requires `numPassedTests === numTotalTests`, and a source test that quietly skips because someone
  forgot a variable is exactly the false green this tier exists to prevent. The throw names the
  missing variables.

**Isolation and cleanup.** Every name is keyed on `CI_PIPELINE_ID` (a per-process value locally): the
S3 prefix `ci/<run>/`, the uploaded filename, the PostgreSQL table, the SCO target object. Concurrent
MR pipelines therefore cannot collide on the shared sources. Cleanup deletes the S3 prefix and the
table — unlike totalview, which never removes its objects. That matters because `interruptible: true`
makes killed jobs routine.

**Runner.** `tags: [aws-x86]`, overriding `default:`. The protected local runners cannot reach
external sources; this project can see three online `aws-x86` runners. Whether that fleet permits
privileged dind is not yet proven.

The job anchors on `exists: backend/test/live-source/**/*.live.test.ts`, so while the tier is empty it
does not exist and the pipeline is unchanged.