/**
 * Deploy → enable → poll → verify: the half of a Data Integration pipeline that no
 * other tier exercises.
 *
 * `integration-generator.it.test.ts` stops at "the generated classes compile", and
 * `interop.it.test.ts` stops at "the config item was added" — `production-ops.ts`
 * defaults items to `enabled: false`, so no existing test ever starts an inbound
 * adapter. Everything after that point (the adapter settings baked into OnInit, the
 * CSV parse, the DTL mapping, the BPL upsert, the target `%Save()`) is unproven.
 * This helper is that step, kept source-agnostic so the S3 / SFTP / FTP / PostgreSQL
 * suites reuse it unchanged. Deploy itself runs through a real agent turn
 * ({@link deployViaAgent}), because that is the only path the Deploy button has.
 *
 * All state it creates is registered on the caller's `cleanups` array as it goes,
 * so a failure half-way still tears down (runCleanups runs them in reverse).
 */
import {
  integrationClassNames,
  sanitizeIntegrationName,
  type IntegrationClassNames,
} from '../../../src/integration/integration-generator.js';
import type { IrisServices } from '../../../src/iris/index.js';
import {
  enableConfigItem,
  getProductionStatus,
  listConfigItems,
  removeConfigItem,
  startProduction,
  stopProduction,
  type ConfigItemInfo,
} from '../../../src/iris/production-ops.js';
import type { Cleanup } from '../../integration/helpers/provision.js';
import { buildDeployPrompt, deployDisplayText, type WizardJob } from './deploy-prompt.js';

/**
 * A throwaway production, used ONLY when the instance has none running (the CI
 * IRIS is one such instance — the community install starts no production). When a
 * production IS running we deploy onto it and remove our items afterwards, exactly
 * as `interop.it.test.ts` does, so a developer's own production is never replaced.
 */
const TEST_PRODUCTION = 'Workbench.Test.LiveProduction';
const TEST_PRODUCTION_CLS = `Class ${TEST_PRODUCTION} Extends Ens.Production
{

XData ProductionDefinition
{
<Production Name="${TEST_PRODUCTION}" LogGeneralTraceEvents="false"></Production>
}

}`;

/**
 * Does the production actually have live jobs?
 *
 * `GetProductionStatus` can report Running from stale runtime state — an instance
 * restarted without stopping its production keeps the state but loses every job.
 * `Ens.Director.IsProductionRunning` reads the job-status globals instead
 * ("returns whether a production is currently running in this namespace … not as
 * reliable as GetProductionStatus() as it does not lock $$$EnsRuntime and may not
 * accurately reflect the production status while the production is changing
 * state"), so it is 0 in exactly that case. It matters here because enabling an
 * item on a job-less production SUCCEEDS and then nothing ever polls — the test
 * would sit out its whole timeout against an empty Ens log.
 */
function hasLiveJobs(iris: IrisServices): boolean {
  try {
    const raw = iris.native.callValue('Ens.Director', 'IsProductionRunning');
    return raw === 1 || raw === 1n || raw === '1' || raw === true;
  } finally {
    iris.native.drainConnectionState();
  }
}

const deleteClass = (iris: IrisServices, className: string): void => {
  try {
    iris.native.callValue('%SYSTEM.OBJ', 'Delete', className, 'd-d');
  } catch {
    /* tolerant: already gone */
  }
};

/**
 * The production to deploy onto: the instance's own if it has one, else
 * {@link TEST_PRODUCTION}.
 *
 * A namespace has exactly ONE active production, and `Ens.Director.EnableConfigItem`
 * acts on the ACTIVE one — so deploying onto a production that is configured but not
 * active silently adds items nothing will ever enable. `startProduction` reports
 * "already running" as success (its `/AlreadyRunning/i` tolerance), and IRIS returns
 * that error when a DIFFERENT production is running, so this must verify the outcome
 * rather than trust it.
 */
export async function ensureProduction(iris: IrisServices, cleanups: Cleanup[]): Promise<string> {
  const status = getProductionStatus(iris.native);
  if (status.productionName) {
    // A developer's instance has its own production. Deploy onto it and remove our
    // items afterwards, exactly as interop.it.test.ts does — never replace it.
    if (!status.running || !hasLiveJobs(iris)) {
      // Stop first even when the state says Running: a stale production rejects
      // StartProduction with ErrProductionAlreadyRunning, which startProduction
      // reports as success.
      stopProduction(iris.native, 20, 1);
      const resumed = startProduction(iris.native, status.productionName);
      if (!resumed.ok) {
        throw new Error(
          `Production "${status.productionName}" was ${status.stateLabel} with no live jobs and could not be restarted: ${resumed.message}`,
        );
      }
      // It had no jobs when we arrived; leave it stopped rather than half-running.
      cleanups.push(() => {
        stopProduction(iris.native, 20, 1);
      });
    }
    await assertLiveJobs(iris, status.productionName);
    return status.productionName;
  }

  const compiled = await iris.atelier.importAndCompile(TEST_PRODUCTION, TEST_PRODUCTION_CLS);
  if (!compiled.ok) {
    throw new Error(`Could not compile ${TEST_PRODUCTION}: ${compiled.errors.join('; ')}`);
  }
  cleanups.push(() => deleteClass(iris, TEST_PRODUCTION));
  const started = startProduction(iris.native, TEST_PRODUCTION);
  if (!started.ok) throw new Error(started.message);
  // Force the stop: our own inbound service may still be mid-poll against a real
  // remote source, and a hung poll must not leave a running production behind.
  cleanups.push(() => {
    stopProduction(iris.native, 20, 1);
  });
  const after = getProductionStatus(iris.native);
  if (!after.running || after.productionName !== TEST_PRODUCTION) {
    throw new Error(
      `Expected ${TEST_PRODUCTION} to be the active production, but it is ` +
        `"${after.productionName ?? '(none)'}" (${after.stateLabel}). Deploying now would add ` +
        `items to an inactive production, and enabling them would fail with ErrConfigItemNotFound.`,
    );
  }
  await assertLiveJobs(iris, TEST_PRODUCTION);
  return TEST_PRODUCTION;
}

/**
 * Wait briefly for the production's jobs to come up, then fail loudly if they
 * haven't. `IsProductionRunning` is unreliable *while* a production is changing
 * state, so give it a few seconds before believing a 0.
 */
async function assertLiveJobs(iris: IrisServices, productionName: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (hasLiveJobs(iris)) return;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Production "${productionName}" reports Running but has no live jobs ` +
      `(Ens.Director.IsProductionRunning = 0). Enabling items on it would succeed and never poll. ` +
      `Stop and start the production in the Management Portal, then re-run.`,
  );
}

/**
 * Config items this process deployed, in add order. Read by
 * {@link forceStopDeployedHosts}. A reused JavaGateway is not recorded, matching the
 * removal cleanup {@link deployViaAgent} registers.
 */
const deployedItems: string[] = [];

/** Record a config item added outside {@link deployViaAgent} (see Q11 in the PostgreSQL suite). */
export function registerDeployedItem(name: string): void {
  deployedItems.push(name);
}

/**
 * Disable every host this process deployed and force one reconcile — the FIRST thing
 * teardown does, before the ordinary cleanups.
 *
 * Why teardown needs this: `Ens.Director` cannot gracefully stop a running job when
 * it is driven over the Native SDK. `Ens.Job.Stop` locks `^Ens.JobRequest`, sets the
 * terminate request, releases the lock, signals the job, then waits for the job's
 * `^Ens.JobLock`. Over the SDK the release does not take effect — the calling process
 * is in a transaction (`%SYS.ProcessQuery.InTransaction` is non-zero for it and zero
 * for an ordinary SDK call), and IRIS defers `LOCK -` until commit — so the job
 * blocks on the retained lock and the wait ends in `<Ens>ErrJobNotStopped`. The same
 * call from an IRIS terminal succeeds in ~10ms. `production-ops.ts` then retries at
 * 15/25/35s, so EVERY config-item operation costs ~85s and the job STILL does not
 * stop: eight of them blew the 600s hookTimeout with all 11 tests passing.
 *
 * `UpdateProduction(timeout, force=1)` does work over the SDK (5s, production
 * up-to-date, no orphan) because `Ens.Job.Stop`'s force branch terminates the process
 * outright. So: disable each host WITHOUT hot-applying (`EnableConfigItem(name,0,0)`
 * — the hot-apply is the step that cannot stop the job), then force one reconcile.
 * The `enableConfigItem`/`removeConfigItem` cleanups that follow have no running job
 * left to stop and finish in seconds.
 *
 * Deliberately NOT in `production-ops.ts`: force-terminating a user's host is a
 * product decision, so the workbench's own behaviour is left exactly as it is.
 * Filed as SC-2718.
 *
 * Best-effort — returns warnings rather than throwing, because teardown must run.
 */
export async function forceStopDeployedHosts(iris: IrisServices): Promise<string[]> {
  const notes: string[] = [];
  if (deployedItems.length === 0) return notes;
  // A fresh connection, for the reason in productionItems: on the shared one
  // Ens.Director cannot even find an item another connection added.
  return iris.native.withFreshConnection((native) => {
    try {
      for (const name of deployedItems) {
        try {
          native.callValue('Ens.Director', 'EnableConfigItem', name, 0, 0);
        } catch (err) {
          notes.push(`force-stop: could not disable "${name}": ${String(err)}`);
        }
      }
      const forced = native.decodeStatus(native.callValue('Ens.Director', 'UpdateProduction', 10, 1));
      if (!forced.ok) notes.push(`force-stop: forced UpdateProduction failed: ${forced.text}`);
    } catch (err) {
      notes.push(`force-stop: ${String(err)}`);
    } finally {
      native.drainConnectionState();
      deployedItems.length = 0;
    }
    return notes;
  });
}

/**
 * A production's config items, read on a FRESH connection.
 *
 * `Ens.Config.Production.%OpenId` is cached per IRIS process, so a long-lived
 * connection that has opened the production once never sees an item another
 * connection added: the list stays stale and `Ens.Director.EnableConfigItem` throws
 * `<INVALID OREF>`. Verified directly against live IRIS. Every production read and
 * write in the product runs on a fresh connection for this reason (see
 * `sco_list_config_items` in production-tools.ts), including the agent's tools, so
 * anything checking the agent's work must too.
 */
function productionItems(iris: IrisServices, productionName: string): Promise<ConfigItemInfo[]> {
  return iris.native.withFreshConnection((c) => listConfigItems(c, productionName));
}

export interface DeployedPipeline {
  productionName: string;
  names: IntegrationClassNames;
  /** Config-item names in add order; the inbound service is last. */
  itemNames: string[];
  /** The inbound service — the item whose enable starts the polling. */
  serviceName: string;
}

// ── The Deploy button's real path: an agent turn ───────────────────────────────

/** One SSE frame from `/api/agent/chat`. */
interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Parse the `event:`/`data:` frames of an SSE response body. Keep-alive comment
 * frames (`: connected`) carry no data and are skipped.
 */
async function* sseFrames(res: Response): AsyncGenerator<SseFrame> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('/api/agent/chat returned no body');
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    for (let cut = buf.indexOf('\n\n'); cut >= 0; cut = buf.indexOf('\n\n')) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      yield { event, data: JSON.parse(data) as Record<string, unknown> };
    }
  }
}

/** The agent's own `ui_report_status` payload for the deploy. */
export interface AgentStatusReport {
  phase: string;
  ok: boolean;
  detail?: string;
}

export interface AgentDeployedPipeline extends DeployedPipeline {
  /** What the agent reported through `ui_report_status`. */
  status: AgentStatusReport;
}

/**
 * Deploy exactly as the wizard's Deploy button does: build the SAME prompt
 * ({@link buildDeployPrompt}, twin of the frontend's) and hand it to a REAL agent
 * turn over `/api/agent/chat`, then verify the production state the turn left behind.
 *
 * This is the only way to prove the flow a user actually gets. Calling the generator
 * directly proves the generated ObjectScript works but skips everything the Deploy
 * button really depends on: the skill being found and
 * followed, `sco_generate_integration_classes` resolving the target's key index,
 * `sco_compile_class` / `sco_add_config_item` / `sco_enable_config_item` running in
 * the right order, and `ui_report_status` coming back. A prompt or skill regression is
 * invisible to the direct path and a user-visible outage.
 *
 * The caller's credential must already exist (the wizard creates it BEFORE the turn so
 * the username/password never enter the prompt), and any key/credential files must
 * already be materialized into IRIS.
 *
 * Cleanups are registered BEFORE the turn: a turn that compiles three classes and then
 * fails still has to tear those down. They are tolerant of absence, so registering
 * what the agent MIGHT create is safe.
 *
 * Asserts OUTCOMES only — never the tool transcript. What the agent did with which
 * tool is its business; that the hosts are registered and enabled (and, in the caller,
 * that rows arrive) is the contract. On failure it throws with the SSE transcript, so a
 * red test names the agent's actual error instead of "0 rows".
 *
 * The default `timeoutMs` must stay BELOW the caller's test timeout. A turn killed by
 * vitest reports "Test timed out" and nothing else; aborted here it reports the
 * transcript, which is the only record of how far the agent got. The deploy tests
 * therefore pass an explicit, larger test timeout (an agent turn runs ~60-90s and its
 * latency is not ours to control).
 */
export async function deployViaAgent(
  app: { base: string; iris: IrisServices },
  job: WizardJob,
  classNameByObject: Record<string, string>,
  cleanups: Cleanup[],
  opts: { timeoutMs?: number } = {},
): Promise<AgentDeployedPipeline> {
  const { iris } = app;
  const { timeoutMs = 240_000 } = opts;
  const names = integrationClassNames(String(job.id), sanitizeIntegrationName(job.name));
  const productionName = await ensureProduction(iris, cleanups);
  const isSql = job.source.type === 'database';

  // 1. Teardown first, for whatever the turn gets to. deleteClass is tolerant, so
  //    the SQL case (which has no Business Service class) needs no special case.
  for (const cls of [names.requestClass, names.dtlClass, names.bpConfigName, names.bsConfigName]) {
    cleanups.push(() => deleteClass(iris, cls));
  }
  // A SQL pipeline also needs the shared Java Gateway. It is REUSED when it already
  // exists, and must then not be removed — another pipeline may be using it.
  const existing = new Set((await productionItems(iris, productionName)).map((i) => i.name));
  const itemNames = isSql
    ? [names.bpConfigName, 'JavaGateway', names.bsConfigName]
    : [names.bpConfigName, names.bsConfigName];
  const ownedItems = itemNames.filter((n) => !existing.has(n));
  for (const name of ownedItems) {
    cleanups.push(async () => {
      await iris.native.withFreshConnection((c) => removeConfigItem(c, iris.atelier, productionName, name));
    });
    registerDeployedItem(name);
  }
  // Disabling the inbound service is the FIRST thing teardown does, so the adapter
  // stops polling before its classes and config items are removed.
  cleanups.push(() =>
    iris.native.withFreshConnection((c) => {
      enableConfigItem(c, names.bsConfigName, false);
    }),
  );

  // 2. The turn. `mode` is left at its default ('agent') — Guided mode would drive
  //    the UI instead of IRIS.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const transcript: string[] = [];
  let sessionId = '';
  let status: AgentStatusReport | null = null;
  let streamError = '';
  let stopped = false;

  try {
    const res = await fetch(`${app.base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: buildDeployPrompt(job, classNameByObject),
        displayText: deployDisplayText(job),
      }),
      signal: abort.signal,
    });
    if (res.status !== 200) {
      throw new Error(`/api/agent/chat returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }

    for await (const { event, data } of sseFrames(res)) {
      switch (event) {
        case 'session':
          sessionId = String(data.sessionId ?? '');
          break;
        case 'tool_use':
          transcript.push(`tool_use ${String(data.name)}`);
          break;
        case 'tool_result':
          transcript.push(`tool_result ok=${String(data.ok)} ${String(data.text ?? '').slice(0, 300)}`);
          break;
        case 'ui_directive': {
          // The UiControlBroker BLOCKS for 8s per directive without an ack, so the
          // ack is not optional politeness — an unacked turn crawls.
          if (data.action === 'report_status') {
            const v = (data.value ?? {}) as Record<string, unknown>;
            status = { phase: String(v.phase ?? ''), ok: v.ok === true, detail: v.detail ? String(v.detail) : undefined };
            transcript.push(`report_status ${JSON.stringify(status)}`);
          }
          await fetch(`${app.base}/api/agent/ui-ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, directiveId: data.directiveId, applied: true }),
          });
          break;
        }
        case 'confirm_request':
        case 'ask_request':
          // The prompt tells the agent not to ask. If it does anyway, that IS the
          // failure — the Deploy button gives the user no way to answer.
          transcript.push(`${event} ${JSON.stringify(data).slice(0, 300)}`);
          streamError = `the agent asked instead of deploying (${event})`;
          abort.abort();
          break;
        case 'error':
          streamError = String(data.message ?? 'unknown agent error');
          transcript.push(`error ${streamError}`);
          break;
        case 'stopped':
          stopped = true;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (!streamError) streamError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const dump = () => `Agent transcript (${transcript.length} events):\n${transcript.join('\n') || '(nothing)'}`;
  if (streamError) throw new Error(`Deploy turn failed: ${streamError}\n${dump()}`);
  if (stopped) throw new Error(`Deploy turn was stopped before it finished.\n${dump()}`);
  if (!status) throw new Error(`The deploy turn ended without calling ui_report_status.\n${dump()}`);
  if (status.phase !== 'deployed' || !status.ok) {
    throw new Error(`The agent reported the deploy as failed: ${JSON.stringify(status)}\n${dump()}`);
  }

  // 3. Verify the state the turn claims to have left. `ok:true` is the agent's word;
  //    this is the production's.
  const after = new Map((await productionItems(iris, productionName)).map((i) => [i.name, i]));
  for (const name of itemNames) {
    const item = after.get(name);
    if (!item) throw new Error(`The agent reported ok but "${name}" is not on ${productionName}.\n${dump()}`);
    if (!item.enabled) throw new Error(`"${name}" was registered but left DISABLED, so nothing polls.\n${dump()}`);
  }

  return {
    productionName,
    names,
    itemNames,
    serviceName: names.bsConfigName,
    status,
  };
}

/** `SC.Data.Customer` → `SC_Data.Customer` (the SQL name of a persistent class). */
export function sqlTableFor(className: string): string {
  const parts = className.split('.');
  return `${parts.slice(0, -1).join('_')}.${parts[parts.length - 1]}`;
}

/**
 * Highest `Ens.Util.Log` id right now. Take this before enabling a pipeline, then
 * pass it to {@link ensLogSince} so a diagnostic dump shows only THIS run's entries.
 */
export async function ensLogHighWater(iris: IrisServices): Promise<number> {
  const rows = await iris.atelier.query<{ maxid: number | string | null }>(
    'SELECT MAX(ID) AS maxid FROM Ens_Util.Log',
  );
  return Number(rows[0]?.maxid ?? 0);
}

/**
 * Ens log entries newer than `sinceId`, as text. Without this a failed ingestion
 * says only "0 rows" — the reason (a bad ProviderCredentialsFile, a missing column,
 * an FK violation) is only ever in this table.
 */
export async function ensLogSince(iris: IrisServices, sinceId: number, limit = 40): Promise<string> {
  const rows = await iris.atelier.query<{
    ID: number;
    ConfigName: string | null;
    Type: string | number | null;
    SourceMethod: string | null;
    Text: string | null;
  }>(
    `SELECT TOP ${limit} ID, ConfigName, Type, SourceMethod, Text FROM Ens_Util.Log
      WHERE ID > ? ORDER BY ID DESC`,
    [sinceId],
  );
  if (!rows.length) return '(no Ens.Util.Log entries — the service logged nothing at all)';
  return rows
    .map((r) => `#${r.ID} [${r.Type}] ${r.ConfigName ?? ''} ${r.SourceMethod ?? ''}: ${r.Text ?? ''}`)
    .join('\n');
}

export interface WaitForRowsOptions<T> {
  /** Keep polling until this is true of the rows currently in the target. */
  until: (rows: T[]) => boolean;
  /** What is being waited for, quoted in the timeout message. */
  label: string;
  /** Ens log id taken before the pipeline was enabled (for the failure dump). */
  sinceLogId: number;
  timeoutMs?: number;
  intervalMs?: number;
  /** Column to order by, so assertions can index rows deterministically. */
  orderBy?: string;
}

/**
 * Poll the target class over SQL until `until(rows)` holds, then return the rows.
 *
 * On timeout it throws with BOTH the last row snapshot and the Ens log since
 * `sinceLogId` — the diagnostic that turns "expected 3, got 0" into the actual IRIS
 * error. The default budget is generous because an inbound adapter's CallInterval
 * (5s by default) plus a cloud round trip means the first row can be ~15s away.
 */
export async function waitForRows<T extends Record<string, unknown>>(
  iris: IrisServices,
  className: string,
  opts: WaitForRowsOptions<T>,
): Promise<T[]> {
  const { until, label, sinceLogId, timeoutMs = 120_000, intervalMs = 2_000, orderBy } = opts;
  const sql = `SELECT * FROM ${sqlTableFor(className)}${orderBy ? ` ORDER BY ${orderBy}` : ''}`;
  const deadline = Date.now() + timeoutMs;
  let rows: T[] = [];
  for (;;) {
    rows = await iris.atelier.query<T>(sql);
    if (until(rows)) return rows;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label} in ${className}.\n` +
      `Rows now (${rows.length}): ${JSON.stringify(rows)}\n` +
      `Ens.Util.Log since #${sinceLogId}:\n${await ensLogSince(iris, sinceLogId)}`,
  );
}
