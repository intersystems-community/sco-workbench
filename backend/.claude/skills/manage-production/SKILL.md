---
name: manage-production
description: Deploy and configure SCO Interoperability (Ensemble) business hosts on a running production. Use when the user wants to add, configure, enable, or disable a business service, business process, or business operation on an SCO production — including deploying a new interop class and wiring it into the active production. Everything is done in ObjectScript via the Ens.* APIs.
---

# Manage an SCO Interoperability Production

You deploy interoperability business hosts (business **services**, **processes**, **operations**) and configure them on a running SCO production. All operations use pure ObjectScript through the `sco_*` tools (`Ens.Director`, `Ens.Config.Production`, `Ens.Config.Item`) — no Python. Adding/enabling items changes a running production, so the user will be asked to approve each such step.

## Configure first, start later (IMPORTANT)
**Do NOT enable a host by default.** Enabling a service/process starts it running immediately — a business service may begin polling/accepting inbound work as soon as it is enabled, which the user may not want yet. So the default flow is:
1. Configure the host on the production **disabled**.
2. Tell the user which services you have finished configuring.
3. **Ask** whether they want to start (enable) the process now. Only enable it if they say yes.

Do not enable a host in the same step as adding it unless the user explicitly asked to start/run it right away.

## Typical task: deploy and configure a host
Given an interop `.cls` (e.g. a business process `Workbench.Test.BP`), do this in order:

1. **`sco_production_status`** (read-only) — find the active production name and whether it is running. You need the production name for the next step. If no production is active, tell the user; do not guess a name.
2. **`sco_compile_class`** — import + compile the host class so it exists before you reference it. (See the compile-class skill.) A config item pointing at an uncompiled class will fail.
3. **`sco_add_config_item`** — add the host to the production: `{ productionName, className, name?, enabled?, poolSize? }`. **Leave `enabled` unset (defaults to `false`)** so the host is configured but does not start running. `poolSize` defaults to `1` (a dedicated pool) — do not set it to `0` for a host you want left disabled, because a PoolSize-0 host shares the `Ens.Actor` pool and keeps processing requests even when disabled. This opens the production with `Ens.Config.Production.%OpenId`, inserts a new `Ens.Config.Item` (or updates the existing one with the same name in place — never duplicating), and `%Save`s. Existing items are preserved. It then applies the change to the running production via `Ens.Director.UpdateProduction` **only if this production is the active one** (no stop/start, no class recompile).
4. **`sco_production_status`** — confirm the production is still running.
5. **Report and ask.** Tell the user the host is configured (disabled) and ask whether they want to start it now. Do not proceed to enable without a yes.
6. **`sco_enable_config_item`** `{ name, enabled: true }` — only after the user confirms — to start the host.

## Enabling / disabling an existing item
Use **`sco_enable_config_item`** `{ name, enabled }` to toggle an already-configured item. It calls `Ens.Director.EnableConfigItem(name, enabled, 1)`, where the trailing `1` hot-applies the change. (Note: `StartConfigItem`/`StopConfigItem` do not exist — do not attempt them.)

**Trust the tool result — do NOT retry a successful enable.** The tool already treats these as **success** (`ok: true`) because the Enabled flag was persisted; just relay the message:
- **`ErrJobNotStopped` / "reload timeout"** — the hot-apply's `UpdateProduction` couldn't stop some host within 10s (usually OTHER, unrelated slow/stuck hosts on the production, not the item you enabled). The item IS enabled and will run on the next reconcile. Report it as a warning, don't retry.
- **"was already enabled/disabled"** — idempotent no-op success.
Retrying an enable that already succeeded just produces a confusing "already enabled" error and extra production churn — so when the tool returns `ok: true`, move on.

## Applying pending changes
Use **`sco_update_production`** to apply pending config changes to the running production. Prefer `UpdateProduction` over stopping and starting the production — a stop/start can lose in-flight messages.

## Rules
- Add hosts **disabled** by default; enable only after the user explicitly asks to start the process.
- Config items are managed through the `Ens.Config.Production`/`Ens.Config.Item` object API and saved to the config store — the production class is **never** recompiled. Recompiling a running production would restart every job and can wedge it (`ErrCanNotAcquireRuntimeLock`); the object API touches only the changed item and preserves all existing items.
- Confirm the exact production name and item before changing a running production; summarize what you will change.
- Report each step's outcome from the tool result; check `ok` and relay the message. If a step fails, quote the decoded `%Status` error and stop rather than continuing.
- Do not create or install any helper classes in SCO — use only the existing `Ens.*` APIs through the provided tools.
