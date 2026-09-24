import { defineConfig } from 'vitest/config';

// Five test tiers selected by PROJECT (no RUN_IRIS_IT env flag):
//   npm run test:unit → --project unit         (test/unit; no IRIS)
//   npm run test:it   → --project integration  (test/integration; live IRIS)
//   npm run test:e2e  → --project e2e          (test/e2e; live IRIS)
//   npm run test:live → --project live-source  (test/live-source; live IRIS + REAL
//                                               external sources — S3/SFTP/FTP/PostgreSQL)
//   npm run test:agent-eval → --project agent-eval  (test/agent-eval; live IRIS +
//                                               Bedrock — scores real agent turns)
// A bare `vitest run` (IDE "run test" button, root `npm test`) runs the DEFAULT
// project set — we scope that to UNIT ONLY below so nothing touches IRIS by
// default. The live tiers are opted into explicitly via their --project scripts.
const common = {
  environment: 'node' as const,
  testTimeout: 30_000,
  hookTimeout: 60_000,
  // Fail on a stray .only in EVERY environment, not just CI. vitest's allowOnly
  // defaults to !isCI, so CI already rejects .only; this states the guard in config
  // and makes local `test:unit:ci` reject it too, giving the same signal before push.
  allowOnly: false,
};

export default defineConfig({
  test: {
    // Heal the DeepSee cube registry once before and once after the whole run.
    // Tolerant-always (no-ops if IRIS is unreachable), so it is safe even on a
    // unit-only run. Guarantees a clean start even if a prior run crashed
    // mid-way, and a clean finish regardless of suite order.
    globalSetup: ['test/integration/helpers/global-setup.ts'],
    // Integration + e2e suites share ONE live IRIS and the Workbench.Test.*
    // namespace, so running test files in parallel workers lets one suite's
    // cleanup wipe another's in-flight artifacts. Disable file-level parallelism:
    // suites run sequentially. (Unit is fast and unaffected.)
    fileParallelism: false,
    projects: [
      {
        test: {
          ...common,
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          ...common,
          name: 'integration',
          include: ['test/integration/**/*.it.test.ts'],
        },
      },
      {
        test: {
          ...common,
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
          // E2E flows chain many serial IRIS round-trips (create object → discover
          // → load rows → compile+build cube → create+query KPI). They legitimately
          // run longer than a single-feature integration test, and the scmodel
          // create/list call grows as create-only custom objects accumulate on the
          // instance — so give them a larger per-test budget.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          ...common,
          name: 'live-source',
          include: ['test/live-source/**/*.live.test.ts'],
          // These tests deploy a generated pipeline into IRIS, ENABLE it, and then
          // poll a real production until rows arrive from a real S3 bucket / SFTP /
          // FTP / PostgreSQL server. That is strictly slower than e2e (which never
          // enables anything), and it adds real network latency to an EC2 box.
          testTimeout: 180_000,
          // Teardown is the slow part, not the tests. Removing an ENABLED host from a
          // running production hot-applies the change, and over the Native SDK that
          // hot-apply can never stop the host's job: it costs 10+15+25+35s per
          // config-item operation and leaves the job running (mechanism and the
          // force-stop that avoids it: forceStopDeployedHosts in helpers/ingest.ts).
          // The force-stop keeps teardown in the tens of seconds; the budget stays
          // generous because it is best-effort and the slow path is still reachable.
          hookTimeout: 600_000,
        },
      },
      {
        test: {
          ...common,
          name: 'agent-eval',
          include: ['test/agent-eval/**/*.eval.test.ts'],
          // Its own project, not part of the integration tier, so that opting out
          // is "do not select the project" rather than a `.skip` — CI's test-file
          // guard fails any tier that reports a skipped test. Each scenario drives
          // a REAL agent turn and sets its own per-test ceiling (185s); the hook
          // budget covers seeding a source and building a cube first.
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
