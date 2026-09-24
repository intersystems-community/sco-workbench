# Development

How to run SCO Workbench from source and test it. Users deploying the Workbench only need the
[README](../README.md) — this file is for contributors.

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Run](#run)
- [Tests](#tests)
- [Node version & native modules](#node-version--native-modules)
- [Utility scripts](#utility-scripts)

## Prerequisites

- **Node.js 22** — the version pinned in [`.nvmrc`](../.nvmrc). With
  [nvm](https://github.com/nvm-sh/nvm), run `nvm use` (or `nvm install`) from the repo root. Angular
  21's build accepts `^20.19.0 || ^22.12.0 || >=24.0.0`, but use the pinned 22: the backend's native
  module `better-sqlite3` has no prebuilt binary for the newest Node lines (e.g. 25) and fails to
  compile there. See [Node version & native modules](#node-version--native-modules).
- **A running SCO instance**, reachable on the web port (52773) and superserver port (1972), and the
  name of the namespace you created for it. The live test tiers need it too.
- **Java** (a JRE) if you want the Data Integration "Test Connection" for database sources to work
  locally — it runs real JDBC through a small Java helper. Without Java the test degrades to a clear
  "Java not available" message instead of failing to boot. macOS: `brew install openjdk`; Ubuntu:
  `sudo apt install default-jre`.
- **Optional: one Claude provider** for the AI features. [.env.example](../.env.example) has a block
  per provider with the exact variables; without one the app still runs and every non-AI feature
  works.

`@intersystems/intersystems-iris-native` installs from the public npm registry (no IRIS-kit tarball)
and ships prebuilt Linux/Docker binaries.

## Setup

```bash
nvm use                   # select Node 22 (reads .nvmrc) — in every new shell
cp .env.example .env      # IRIS credentials (+ a Claude provider, if you want the AI features)
npm install               # installs all workspaces (builds better-sqlite3 for the active Node)
```

Run `nvm use` **before** `npm install`: `better-sqlite3` is compiled for whichever Node is active, so
installing under the wrong version — or switching Node afterwards — makes the backend fail to start.

## Environment variables

`.env.example` is written for the Docker deployment, so a source checkout needs three overrides
appended to your `.env`:

```ini
SCO_HOST=localhost                           # not host.docker.internal: the backend runs on your host
SQLITE_PATH=./data/workbench.sqlite          # the /data default only exists inside the container
JDBC_LIB_DIR=/absolute/path/to/repo/backend/jdbc-lib   # for the JDBC "Test Connection"
```

Everything a local run needs beyond that is already in `.env.example`: the IRIS connection
(`SCO_HOST`, `SCO_WEB_PORT`, `SCO_SUPERSERVER_PORT`, `SCO_NAMESPACE`, `SCO_USER`,
`SCO_PASSWORD` — the last three required) and the Claude provider block.

For anything else, **[`backend/src/config/env.ts`](../backend/src/config/env.ts) is the source of
truth**: one Zod schema listing every variable, its default and a comment on why it exists (request
timeouts and retries, `WORKBENCH_API_TOKEN`, `BIND_HOST`, `API_BASE_URL`, `AGENT_MAX_TURNS`, the IRIS
upload directories, `SAMPLE_DATA_DIR`, the JDBC paths). A bad value fails the boot with a message
naming it, rather than limping along.

The **frontend needs no environment variables** — it only ever calls the backend over relative
`/api` paths.

## Run

```bash
nvm use
npm run dev               # backend (:3000) + Angular dev server (:4300), both in watch mode
# open http://localhost:4300   (the dev server proxies /api and /healthz to :3000)
```

`npm run dev` starts **both** servers. If you start only the Angular server, its console fills with
`[vite] http proxy error … ECONNREFUSED` for `/config.json` and `/api/*` — that just means the
backend on `:3000` is not up yet. Start it and they clear.

To check the production single image:

```bash
docker compose up --build # Angular app + API + IRIS proxy on :3000
```

**Access model.** The backend authenticates every `/api/*` call with a bearer token and binds to
loopback by default. Locally you set nothing: it generates an ephemeral token at boot, serves it to
the app via `/config.json`, and the browser attaches it automatically. Set `WORKBENCH_API_TOKEN` for
a stable token (e.g. scripted access). To expose a locally-run backend off-host, set `BIND_HOST` and
treat the token as the control.

**Data files live where IRIS runs, not where the agent runs.** The agent reaches IRIS over the
network and cannot see your filesystem; a path like `/tmp/customers.csv` is opened by the IRIS
process. Put the file on the IRIS host first (`docker cp customers.csv <iris-container>:/tmp/`) and
give the path **as IRIS sees it** — it is trusted verbatim and never opened locally.

## Tests

Three tiers, each selected by its own script (a bare `npm test` runs **unit only**):

```bash
npm install         # run first — a pull/merge may have added packages; a stale
                    # node_modules causes "Cannot find module" errors during tests
npm run test:unit   # unit tests, no IRIS required (also the default `npm test`)
npm run test:it     # live INTEGRATION tests against IRIS — per feature (uses .env)
npm run test:e2e    # live E2E tests against IRIS — multi-component flows (uses .env)
```

Run `npm install` before the tests, particularly after a `git pull`/merge: a coworker may have added
a dependency, and a stale `node_modules` fails with a spurious `Cannot find module …` at import time
rather than a real test failure. If `better-sqlite3` then reports a `NODE_MODULE_VERSION` mismatch,
rebuild it — see [Node version & native modules](#node-version--native-modules).

The live suites assume a **clean SCO instance** (default cubes and data model, no user KPIs or custom
cubes, tables possibly empty) and are **self-provisioning**: each test seeds its own
`Workbench.Test.*` artifacts with run-unique names and tears them down in `afterEach`, plus an
`afterAll` backstop sweep — so they are order-independent and re-runs are idempotent. They run
**sequentially** (one shared live IRIS), and are **non-invasive**: they never stop or modify a
production you already have running (a test only starts its own throwaway production if none is
active, and stops it afterwards).

Read [integration-testing.md](integration-testing.md) for the full standard — the clean-IRIS
baseline, self-provisioning, per-test cleanup and what each suite covers — before adding a suite.

## Node version & native modules

The backend depends on **`better-sqlite3`**, a native addon compiled against a specific Node ABI.

1. **Use the pinned Node 22** (`nvm use`) in every shell that runs `npm install`, `npm run dev` or
   the tests. A brand-new Node line may have **no prebuilt binary**, so `npm install` tries to
   compile from source and fails in `node-gyp`.
2. **If you switch Node versions after installing**, rebuild the addon:

   ```bash
   nvm use
   npm rebuild better-sqlite3 --workspace backend
   ```

| Symptom | Cause and fix |
|---|---|
| `npm install` fails with `gyp ERR! … not ok` / `No prebuilt binaries found (target=25.x)` | Node is too new. `nvm use`, delete the partial build, reinstall. |
| Backend exits at startup with `NODE_MODULE_VERSION 115 … requires 127` | The addon was built for a different Node than the one running it. Run the `npm rebuild` above. |
| Angular server logs `ECONNREFUSED` for `/config.json` and `/api/*` | The backend is not running (often because of the above). Start it with `npm run dev`. |

## Utility scripts

### Clean up test artifacts

Every integration run cleans up in its `afterAll`. To remove artifacts manually:

```bash
npm run cleanup:test
```

It is idempotent and **only** touches:

- config items `Workbench.Test.BS` / `Workbench.Test.BP` on the active production,
- the test cubes' data (`%KillCube`) and classes (`WorkbenchTestSource`, `WorkbenchTestRestCube`,
  `WorkbenchTestCrud` under `SC.Workbench.Cube.*`),
- all `Workbench.Test.*` classes.

Everything else in IRIS is left alone — including the example cube below, which it does **not**
delete.

### Seed an example cube

For one complete, **editable** cube to explore in Analytics Cube:

```bash
npm run seed:example-cube
```

This builds `SC.Workbench.Cube.WorkbenchExampleSalesCube` over `SC.Data.SalesOrder` with a data
dimension, a multi-level time dimension (Year→Month→Day) and SUM/AVG/MAX measures — every field the
create/edit form supports. It goes through the normal generate→compile→build pipeline, so it is a
real, fully editable Workbench cube. Delete it from the UI or with
`DELETE /api/cubes/WorkbenchExampleSalesCube`.
