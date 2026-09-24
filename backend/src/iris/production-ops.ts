import type { IrisObject, NativeClient } from './native-client.js';

/** One production config setting (an `Ens.Config.Setting` row). */
export interface ConfigSetting {
  /** Setting name, e.g. "DSN", "Query", "%gatewayName". */
  name: string;
  /** Where the setting applies: "Adapter" or "Host". Defaults to "Host". */
  target?: 'Adapter' | 'Host';
  /** The setting value (always stored as a string in IRIS). */
  value: string;
}

/** Spec for a business host config item (service/process/operation). */
export interface ConfigItemSpec {
  className: string;
  name?: string;
  enabled?: boolean;
  poolSize?: number;
  /**
   * Adapter/host settings to apply (e.g. the SQL GenericService's DSN/Query/
   * Credentials/JGService/JDBCDriver, or the JavaGateway's %gatewayName). Each is
   * upserted by (name, target): an existing setting of the same name+target is
   * updated in place, otherwise a new one is inserted — so re-running keeps a
   * single row per setting instead of appending duplicates.
   */
  settings?: ConfigSetting[];
}

/**
 * IRIS Interoperability (Ensemble) production management.
 *
 * Config items are added/updated through the `Ens.Config.Production` /
 * `Ens.Config.Item` **object API** run over the Native SDK — open the
 * production, insert or find the item, set its scalar properties, persist with
 * `%Save()`, then `UpdateProduction` to apply the change to the running
 * production.
 *
 * Why `%Save()` and NOT `SaveToClass()`: `%Save()` writes the item to the
 * interoperability config store, which is what `%OpenId` and `UpdateProduction`
 * read to rebuild the running production — verified live that a `%Save()`-only
 * add is visible on reopen and the reconcile clears `ProductionNeedsUpdate`.
 * `SaveToClass()` additionally **recompiles** the production class, and a
 * recompiled class makes the next `UpdateProduction` treat every running job as
 * stale and stop/restart ALL hosts. On a busy production those stops exceed the
 * timeout (<Ens>ErrJobNotStopped), the update aborts half-applied, and the
 * Portal is left showing its red "Update" button. So we deliberately do not
 * recompile the class on the runtime path.
 *
 * Note on the Portal's `#5001 "Production items not found, may require
 * recompilation"`: it is NOT a runtime-vs-class store mismatch. It is raised by
 * `EnumerateConfigItems` when an item's host CLASS cannot be instantiated
 * (`Items.GetAt(i)` returns a non-object) — i.e. the host class isn't compiled.
 * The fix for that is compiling the host class before adding it (the pipeline
 * does), not rewriting the production class XData.
 *
 * Native SDK note: an oref can be passed as an argument via `invokeVoid`
 * (e.g. `Items.Insert(item)`), but methods that return an IRIS integer/%Status
 * must be read with `invokeString` — the numeric/object return paths throw
 * "Do not know how to serialize a BigInt".
 */

const DIRECTOR = 'Ens.Director';
const PRODUCTION = 'Ens.Config.Production';
const CONFIG_ITEM = 'Ens.Config.Item';

/**
 * Numeric production-state code → label, from `$$$eProductionState*` in
 * EnsConstants.INC (read out of the live instance — a clean StopProduction leaves
 * state 2, which is Stopped, not Suspended):
 *   0 Unknown, 1 Running, 2 Stopped, 3 Suspended, 4 Troubled, 5 NetworkStopped,
 *   6 ShardWorkerProhibited. Mirror-backup states are the negatives of these.
 */
const STATE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Running',
  2: 'Stopped',
  3: 'Suspended',
  4: 'Troubled',
  5: 'NetworkStopped',
  6: 'ShardWorkerProhibited',
};

export interface ProductionStatus {
  productionName: string | null;
  state: number;
  stateLabel: string;
  running: boolean;
}

export interface OpResult {
  ok: boolean;
  message: string;
}

/**
 * Read the current production and its state.
 * `##class(Ens.Director).GetProductionStatus(.name, .state)` → %Status,
 * with name/state returned by reference. The Native SDK cannot pass by
 * reference cleanly, so we read the two values via separate calls that the
 * driver supports: GetActiveProductionName() and GetProductionStatus using an
 * IRISReference. To stay simple and robust we use the dedicated accessors.
 */
export function getProductionStatus(native: NativeClient): ProductionStatus {
  const name = native.callValue(DIRECTOR, 'GetActiveProductionName');
  const productionName = typeof name === 'string' && name.length ? name : null;
  // GetProductionStatus returns the state as its return value in this usage;
  // when no production is configured it yields 0 (Stopped).
  const stateRaw = native.callValue(DIRECTOR, 'GetProductionStatus');
  // Native SDK may return integers as BigInt.
  const state = typeof stateRaw === 'bigint' ? Number(stateRaw) : Number(stateRaw) || 0;
  return {
    productionName,
    state,
    stateLabel: STATE_LABELS[state] ?? `Unknown(${state})`,
    running: state === 1,
  };
}

/** A production config item, as listed for inspection. */
export interface ConfigItemInfo {
  name: string;
  className: string;
  enabled: boolean;
}

/**
 * List the config items of a production (name, class, enabled). Read-only — used
 * to check what a data pipeline registered before deleting it, and to ref-count
 * shared hosts like the Java Gateway (is any SQL service still using it?).
 * Returns [] if the production can't be opened.
 */
export function listConfigItems(native: NativeClient, productionName: string): ConfigItemInfo[] {
  try {
    const prod = native.callObject(PRODUCTION, '%OpenId', productionName);
    if (!prod) return [];
    const items = prod.getObject('Items') as IrisObject | null;
    if (!items) return [];
    const count = Number(items.invokeString('Count')) || 0;
    const out: ConfigItemInfo[] = [];
    for (let i = 1; i <= count; i++) {
      const it = items.invokeValue('GetAt', i) as IrisObject | null;
      if (!it || typeof it !== 'object') continue;
      out.push({
        name: it.getString('Name'),
        className: it.getString('ClassName'),
        enabled: it.getString('Enabled') === '1',
      });
    }
    return out;
  } finally {
    native.drainConnectionState();
  }
}

/**
 * Read the (Name, Target, Value) settings of one config item — the inverse of
 * the `settings` upsert done by {@link addOrUpdateConfigItem}. Read-only; used to
 * verify a SQL GenericService's DSN/Query/Credentials/etc. actually landed (and
 * that a re-deploy updated a setting in place rather than duplicating its row).
 * Returns [] if the production or item isn't found.
 */
export function readConfigItemSettings(
  native: NativeClient,
  productionName: string,
  itemName: string,
): ConfigSetting[] {
  try {
    const prod = native.callObject(PRODUCTION, '%OpenId', productionName);
    if (!prod) return [];
    let item = prod.invokeValue('FindItemByConfigName', itemName) as IrisObject | null;
    if (!item || typeof item !== 'object') return [];
    const coll = item.getObject('Settings') as IrisObject | null;
    if (!coll) return [];
    const count = Number(coll.invokeString('Count')) || 0;
    const out: ConfigSetting[] = [];
    for (let i = 1; i <= count; i++) {
      const row = coll.invokeValue('GetAt', i) as IrisObject | null;
      if (!row || typeof row !== 'object') continue;
      const target = row.getString('Target');
      out.push({
        name: row.getString('Name'),
        target: target === 'Adapter' ? 'Adapter' : 'Host',
        value: row.getString('Value'),
      });
    }
    return out;
  } finally {
    native.drainConnectionState();
  }
}

/**
 * Add a business host (service/process/operation) to a production, or update it
 * in place if a config item with the same name already exists, then apply the
 * change to the running production.
 *
 * Uses the `Ens.Config.Production`/`Ens.Config.Item` object API (open → find or
 * new → set scalars → `%Save`), which preserves all existing items and never
 * recompiles the production class. When this production is the active/running
 * one, the change is then hot-applied via `UpdateProduction` (no stop/start);
 * otherwise the saved config takes effect on next start. `productionName` is
 * the production's config/class name.
 *
 * The `atelier` parameter is accepted for signature compatibility with callers
 * and is unused — the whole operation runs through the Native SDK.
 */
export async function addOrUpdateConfigItem(
  native: NativeClient,
  _atelier: unknown,
  args: ConfigItemSpec & { productionName: string },
): Promise<OpResult> {
  const { productionName, className } = args;
  const name = args.name ?? className;
  // Disabled by default: configuring a host must not start the workflow. The
  // user enables it afterwards via sco_enable_config_item once they confirm.
  const enabled = args.enabled ?? false;
  // PoolSize defaults to 1 (a DEDICATED pool), not 0. A PoolSize-0 host shares
  // the Ens.Actor pool, and IRIS cannot truly stop such a host when it is
  // disabled — it keeps processing requests ("…marked as disabled … will still
  // process requests"). A dedicated pool makes "disabled" mean genuinely idle,
  // matching the standard Ens deployment convention.
  const poolSize = args.poolSize ?? 1;

  // Everything runs inside a try/finally that drains transaction+lock state so
  // nothing (notably the runtime lock taken by UpdateProduction) lingers on this
  // long-lived connection and wedges the production later.
  try {
    let prod: IrisObject | null;
    try {
      prod = native.callObject(PRODUCTION, '%OpenId', productionName);
    } catch (err) {
      return { ok: false, message: `Could not open production "${productionName}": ${errText(err)}` };
    }
    if (!prod) {
      return { ok: false, message: `Production "${productionName}" not found.` };
    }

    let item: IrisObject | null;
    try {
      // FindItemByConfigName returns an oref for an existing item, or "" → null.
      item = prod.invokeValue('FindItemByConfigName', name) as IrisObject | null;
      if (item && typeof item !== 'object') item = null;
    } catch (err) {
      return { ok: false, message: `Could not inspect production "${productionName}": ${errText(err)}` };
    }

    const isUpdate = item !== null && typeof item === 'object';
    try {
      if (isUpdate) {
        // Update the existing item's scalar properties in place. Only touch
        // PoolSize when the caller explicitly set it — don't silently change an
        // already-configured host's pool.
        const existing = item as IrisObject;
        existing.set('ClassName', className);
        existing.set('Enabled', enabled ? 1 : 0);
        if (args.poolSize !== undefined) existing.set('PoolSize', args.poolSize);
        applySettings(native, existing, args.settings);
      } else {
        // Build a new Ens.Config.Item and insert it into the production. Always
        // set PoolSize (defaults to 1 — a dedicated pool — so a disabled host is
        // truly idle rather than sharing the Ens.Actor pool and still running).
        const fresh = native.callObject(CONFIG_ITEM, '%New');
        if (!fresh) return { ok: false, message: 'Failed to create a new Ens.Config.Item.' };
        fresh.set('Name', name);
        fresh.set('ClassName', className);
        fresh.set('Enabled', enabled ? 1 : 0);
        fresh.set('PoolSize', poolSize);
        applySettings(native, fresh, args.settings);
        const items = prod.getObject('Items') as IrisObject | null;
        if (!items) return { ok: false, message: 'Could not access the production Items collection.' };
        items.invokeVoid('Insert', fresh);
      }
    } catch (err) {
      return { ok: false, message: `Failed to configure item "${name}": ${errText(err)}` };
    }

    // Persist the config change with `%Save()` ONLY — deliberately NOT
    // `SaveToClass()`.
    //
    // `%Save()` writes the item to the interoperability config store, from which
    // `Ens.Config.Production.%OpenId` rebuilds the Items collection — verified
    // live: after a `%Save()`-only add the item is present on reopen and
    // `ProductionNeedsUpdate` is cleared by the reconcile below.
    //
    // `SaveToClass()` additionally rewrites and **recompiles** the production
    // class. That recompile is what caused the host-restart storm: a recompiled
    // production class makes the next `UpdateProduction` treat the running jobs
    // as stale and stop/restart EVERY host. On a busy production those stops blow
    // the 10s timeout (<Ens>ErrJobNotStopped), the update aborts half-applied,
    // and the Portal is left showing the red "Update" button (exactly the log the
    // user reported: add-BP fine, add-BS restarts all six hosts and times out).
    // Skipping SaveToClass avoids the recompile entirely, so the reconcile no
    // longer churns unrelated hosts.
    //
    // The Portal's `#5001 "Production items not found, may require recompilation"`
    // is NOT a runtime-vs-class store mismatch: that error comes from
    // `EnumerateConfigItems`, which raises it when an item's host CLASS cannot be
    // instantiated (`Items.GetAt(i)` returns a non-object). The remedy is
    // compiling the host class before adding it (the pipeline does this), not
    // rewriting the production class XData here.
    const saved = native.decodeInstanceStatus(prod, '%Save');
    if (!saved.ok) {
      return { ok: false, message: `Failed to save production "${productionName}": ${saved.text}` };
    }

    // Reconcile the running production after EVERY add — including a disabled
    // one. `%Save()` only updates the stored config; without an
    // `UpdateProduction` the running production stays "out of date" (the Portal's
    // red Update button) and its queueInfo panel 500s with "No queue found for
    // this item". Because we no longer recompile the class, this reconcile is a
    // cheap no-op on the other hosts — verified live (~4-5ms, no host restarted,
    // NEEDS_UPDATE cleared). `applyToRunningProduction` still tolerates
    // ErrJobNotStopped as a non-fatal warning for the enabled/busy case.
    const applied = applyToRunningProduction(native, productionName);
    if (!applied.ok) {
      return {
        ok: false,
        message: `Item ${isUpdate ? 'updated' : 'added'}, but applying to the running production failed: ${applied.note}`,
      };
    }

    const verb = isUpdate ? 'updated on' : 'added to';
    const state = enabled
      ? 'enabled'
      : 'left disabled — it is configured and will not run until you start/enable it';
    return {
      ok: true,
      message: `Config item "${name}" (${className}) ${verb} "${productionName}" and ${state}. ${applied.note}`,
    };
  } finally {
    native.drainConnectionState();
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CONFIG_SETTING = 'Ens.Config.Setting';

/**
 * Upsert a list of settings onto a config item's `Settings` collection. Each
 * setting is keyed by (Name, Target): an existing row with the same name+target
 * is updated in place; otherwise a new `Ens.Config.Setting` is inserted. This
 * keeps a single row per setting across re-deploys (a blind Insert would append
 * duplicates, and IRIS uses the LAST value — messy and easy to get wrong).
 */
function applySettings(native: NativeClient, item: IrisObject, settings?: ConfigSetting[]): void {
  if (!settings || settings.length === 0) return;
  const coll = item.getObject('Settings') as IrisObject | null;
  if (!coll) throw new Error('Could not access the config item Settings collection.');
  const count = Number(coll.invokeString('Count')) || 0;

  for (const s of settings) {
    const target = s.target ?? 'Host';
    // Find an existing row with the same Name + Target.
    let found: IrisObject | null = null;
    for (let i = 1; i <= count; i++) {
      const row = coll.invokeValue('GetAt', i) as IrisObject | null;
      if (!row || typeof row !== 'object') continue;
      if (row.getString('Name') === s.name && row.getString('Target') === target) {
        found = row;
        break;
      }
    }
    if (found) {
      found.set('Value', s.value);
    } else {
      const fresh = native.callObject(CONFIG_SETTING, '%New');
      if (!fresh) throw new Error(`Failed to create Ens.Config.Setting "${s.name}".`);
      fresh.set('Name', s.name);
      fresh.set('Target', target);
      fresh.set('Value', s.value);
      coll.invokeVoid('Insert', fresh);
    }
  }
}

/**
 * Apply a just-saved config change to the running production, but only when the
 * modified production is the one currently active. `UpdateProduction` reconciles
 * whatever production is *active* — calling it after editing a different,
 * non-active production is pointless and, worse, would churn the active
 * production's jobs. Returns an advisory note describing what happened.
 *
 * `ErrJobNotStopped` (a host job that won't stop in time) is surfaced as a
 * non-fatal warning: the config change is already persisted and will take
 * effect; forcing jobs down is the user's call, not ours.
 */
function applyToRunningProduction(
  native: NativeClient,
  productionName: string,
): { ok: boolean; note: string } {
  const status = getProductionStatus(native);
  if (!status.running || status.productionName !== productionName) {
    // Not the active production → nothing to hot-apply. The saved config is
    // what the production will use next time it starts / is updated.
    return { ok: true, note: 'saved (production not currently running — change applies on next start).' };
  }

  const applied = updateProduction(native);
  if (applied.ok && !productionNeedsUpdate(native)) {
    return { ok: true, note: 'applied to the running production.' };
  }

  // The reload didn't fully take (ErrJobNotStopped, or still-pending update). Do
  // the Portal's "Update" work FOR the user: retry with longer waits until the
  // production reports up-to-date. Only report deferred if it genuinely can't settle.
  const settle = settleProduction(native);
  if (settle.settled) {
    return { ok: true, note: 'applied to the running production (after waiting for busy jobs to stop).' };
  }
  return {
    ok: true,
    note:
      'saved, but the running production could not be brought up-to-date automatically because other hosts on it are slow/stuck stopping' +
      (settle.lastError ? ` (${settle.lastError})` : '') +
      '. The change is persisted; it will go live when those jobs stop or the production is next updated/restarted.',
  };
}

/**
 * Call an `Ens.Director` method that mutates the runtime and decode its
 * %Status, then ALWAYS drain the connection's transaction/lock state.
 *
 * Every Director mutation (EnableConfigItem, UpdateProduction, Start/Stop) can
 * open a transaction and take the runtime global lock. On our long-lived,
 * reused connection an uncommitted transaction keeps that lock alive until the
 * process dies — which later blocks IRIS internals (the interoperability
 * ScheduleHandler) with <Ens>ErrCanNotAcquireRuntimeLock and wedges the running
 * production. Draining after every such call returns the connection to a clean
 * state so nothing lingers.
 */
function directorCall(native: NativeClient, method: string, ...args: unknown[]): { ok: boolean; text: string } {
  try {
    const status = native.callValue(DIRECTOR, method, ...args);
    return native.decodeStatus(status);
  } finally {
    native.drainConnectionState();
  }
}

/**
 * Enable or disable an existing config item and hot-apply it.
 * Uses `Ens.Director.EnableConfigItem(name, enabled, 1)` — the trailing 1
 * applies the change immediately. (StartConfigItem/StopConfigItem do not exist.)
 *
 * Two IRIS outcomes are treated as SUCCESS rather than failure, because in both
 * the Enabled flag was actually persisted — only the live reload is affected:
 *   - `ErrJobNotStopped`: the trailing-1 hot-apply runs an `UpdateProduction`
 *     that must briefly stop/restart jobs to reconcile. If OTHER (unrelated)
 *     hosts on the production are slow/stuck and don't stop within the 10s
 *     timeout, IRIS returns this — but the item IS enabled and will begin
 *     running on the next reconcile/restart. Same tolerance as the add path
 *     (`applyToRunningProduction`); without it a perfectly good enable looks
 *     like a failure and the caller needlessly retries (and then hits the
 *     "already enabled" error below).
 *   - `already enabled`/`already disabled`: the item is already in the target
 *     state — idempotent, so report success. (This is exactly what a retry after
 *     a swallowed `ErrJobNotStopped` would otherwise surface as an error.)
 */
export function enableConfigItem(
  native: NativeClient,
  name: string,
  enabled: boolean,
): OpResult {
  const verb = enabled ? 'enabled' : 'disabled';
  const decoded = directorCall(native, 'EnableConfigItem', name, enabled ? 1 : 0, 1);
  if (decoded.ok) return { ok: true, message: `Config item "${name}" ${verb}.` };

  // Already in the target state — idempotent success.
  if (new RegExp(`already ${verb}`, 'i').test(decoded.text)) {
    return { ok: true, message: `Config item "${name}" was already ${verb}.` };
  }
  // The Enabled flag persisted, but the live reload couldn't stop a busy job in
  // time. Rather than defer to the user (who'd have to hit the Portal's Update
  // button), drive the production to up-to-date ourselves — retry with longer
  // waits until it settles. Only report deferred if it genuinely can't.
  if (/ErrJobNotStopped/i.test(decoded.text)) {
    const settle = settleProduction(native);
    if (settle.settled) {
      return { ok: true, message: `Config item "${name}" ${verb} and applied to the running production (after waiting for busy jobs to stop).` };
    }
    return {
      ok: true,
      message: `Config item "${name}" ${verb} (saved), but the production could not be brought up-to-date automatically because other hosts on it are slow/stuck stopping. It will go live when those jobs stop or the production is next updated/restarted.`,
    };
  }
  return { ok: false, message: `Failed to ${enabled ? 'enable' : 'disable'} "${name}": ${decoded.text}` };
}

/** Apply pending config changes to the running production. */
export function updateProduction(native: NativeClient, timeoutSecs = 10): OpResult {
  const decoded = directorCall(native, 'UpdateProduction', timeoutSecs, 0);
  return {
    ok: decoded.ok,
    message: decoded.ok ? 'Production updated.' : `UpdateProduction failed: ${decoded.text}`,
  };
}

/**
 * Does the running production still have PENDING config changes not yet applied
 * to the live jobs? This is the SAME state the Management Portal's red "Update"
 * button reflects. `Ens.Director.ProductionNeedsUpdate(.reason)` returns 1 when
 * an update is still needed (0 = fully up-to-date). We pass a by-value
 * placeholder for the by-ref `reason` (the Native SDK can't take it by ref); the
 * boolean return is what we need.
 */
export function productionNeedsUpdate(native: NativeClient): boolean {
  try {
    const raw = native.callValue(DIRECTOR, 'ProductionNeedsUpdate', '');
    return raw === 1 || raw === 1n || raw === '1' || raw === true;
  } catch {
    // If we can't read it, assume it may still need an update (fail toward honesty).
    return true;
  } finally {
    native.drainConnectionState();
  }
}

/**
 * Drive the running production to fully UP-TO-DATE, retrying `UpdateProduction`
 * with escalating timeouts until `ProductionNeedsUpdate()` clears or the effort
 * budget is exhausted.
 *
 * Why this exists: a config save/enable triggers an `UpdateProduction` that must
 * briefly stop/restart the production's jobs. When OTHER, unrelated hosts are
 * slow to stop, IRIS's default 10s stop-wait times out with `ErrJobNotStopped`
 * and the reload is only PARTIALLY applied — the config is saved but the change
 * isn't live, and the Portal shows the red "Update" button. Previously we
 * reported that as done ("applies on next update"), which was a lie: the user
 * still had to open the Portal and hit Update. Here we do that work FOR them —
 * keep updating (with longer waits) until the production reports no pending
 * update. Only if it still can't settle after real effort do we report the
 * honest, specific truth.
 *
 * Bounded: a handful of attempts with growing timeouts (10→20→30s). Each attempt
 * gives IRIS more time to stop the slow jobs; once they stop, the reload
 * completes and `ProductionNeedsUpdate` goes to 0.
 */
export function settleProduction(native: NativeClient): { settled: boolean; lastError: string } {
  const timeouts = [15, 25, 35];
  let lastError = '';
  // Already up-to-date? Nothing to do.
  if (!productionNeedsUpdate(native)) return { settled: true, lastError: '' };
  for (const t of timeouts) {
    const applied = updateProduction(native, t);
    if (!applied.ok) lastError = applied.message;
    if (!productionNeedsUpdate(native)) return { settled: true, lastError: '' };
  }
  return { settled: false, lastError };
}

/** Start a production by name. "Already running" is treated as success. */
export function startProduction(native: NativeClient, productionName: string): OpResult {
  const decoded = directorCall(native, 'StartProduction', productionName);
  if (decoded.ok) return { ok: true, message: `Production "${productionName}" started.` };
  if (/AlreadyRunning/i.test(decoded.text)) {
    return { ok: true, message: `Production "${productionName}" is already running.` };
  }
  return { ok: false, message: `StartProduction failed: ${decoded.text}` };
}

/** Stop the running production gracefully (timeout seconds, force flag). */
export function stopProduction(native: NativeClient, timeout = 10, force = 0): OpResult {
  const decoded = directorCall(native, 'StopProduction', timeout, force);
  return {
    ok: decoded.ok,
    message: decoded.ok ? 'Production stopped.' : `StopProduction failed: ${decoded.text}`,
  };
}

/**
 * Remove a config item from a production via the object API (open → find →
 * `RemoveItem` → `%Save`), then apply to the running production. Used by test
 * cleanup. No-op success if the production or item isn't present.
 *
 * `atelier` is accepted for caller signature compatibility and unused.
 */
export async function removeConfigItem(
  native: NativeClient,
  _atelier: unknown,
  productionName: string,
  name: string,
): Promise<OpResult> {
  try {
    let prod: IrisObject | null;
    try {
      prod = native.callObject(PRODUCTION, '%OpenId', productionName);
    } catch (err) {
      return { ok: false, message: `Could not open production "${productionName}": ${errText(err)}` };
    }
    if (!prod) {
      return { ok: true, message: `Production "${productionName}" not found (nothing to remove).` };
    }

    let item: IrisObject | null;
    try {
      item = prod.invokeValue('FindItemByConfigName', name) as IrisObject | null;
      if (item && typeof item !== 'object') item = null;
    } catch (err) {
      return { ok: false, message: `Could not inspect production "${productionName}": ${errText(err)}` };
    }
    if (!item) {
      return { ok: true, message: `Config item "${name}" not present (nothing to remove).` };
    }

    try {
      // Ens.Config.Production.RemoveItem is a void method; the Native SDK still
      // tries to marshal a return and throws "Function must return a value" even
      // though the server-side removal succeeds. Swallow only that specific
      // marshalling artifact — %Save + a NameExists check below are authoritative.
      prod.invokeVoid('RemoveItem', item);
    } catch (err) {
      if (!/must return a value/i.test(errText(err))) {
        return { ok: false, message: `Failed to remove item "${name}": ${errText(err)}` };
      }
    }

    // `%Save()` only (no `SaveToClass()`), mirroring the add path: SaveToClass
    // recompiles the production class and makes the follow-up UpdateProduction
    // restart every host. The reconcile below applies the removal to the running
    // production without that churn.
    const saved = native.decodeInstanceStatus(prod, '%Save');
    if (!saved.ok) {
      return { ok: false, message: `Failed to save production "${productionName}": ${saved.text}` };
    }

    // Verify the removal actually persisted (NameExists reads the config store).
    const stillThere = native.callValue(CONFIG_ITEM, 'NameExists', productionName, name);
    if (String(stillThere) === '1') {
      return { ok: false, message: `Item "${name}" still present after remove/save.` };
    }

    const applied = applyToRunningProduction(native, productionName);
    return {
      ok: applied.ok,
      message: applied.ok
        ? `Config item "${name}" removed from "${productionName}". ${applied.note}`
        : `Item removed, but applying failed: ${applied.note}`,
    };
  } finally {
    native.drainConnectionState();
  }
}
