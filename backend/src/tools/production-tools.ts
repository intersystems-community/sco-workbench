import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { IrisServices } from '../iris/index.js';
import {
  getProductionStatus,
  addOrUpdateConfigItem,
  enableConfigItem,
  updateProduction,
  listConfigItems,
  removeConfigItem,
} from '../iris/production-ops.js';
import { ok, fail, guard } from './result.js';

/**
 * Tools for managing an IRIS Interoperability production (business
 * services/processes/operations). Pure ObjectScript via the Native SDK.
 * All mutating tools change a possibly-running production and are gated.
 *
 * Every production operation runs on a FRESH, immediately-closed Native
 * connection (`iris.native.withFreshConnection`) rather than the shared
 * long-lived one. An Ens mutation takes the interoperability runtime global lock
 * inside a transaction; on a reused socket any lingering tx/lock state wedges the
 * NEXT request (<Ens>ErrCanNotAcquireRuntimeLock — the "second item added gets
 * stuck" bug). A per-request connection that is torn down when the op settles
 * makes it impossible for that state to cross request boundaries.
 */
export function productionTools(iris: IrisServices) {
  const status = tool(
    'sco_production_status',
    'Get the active SCO Interoperability production name and running state. Read-only.',
    {},
    async () =>
      guard(() =>
        iris.native.withFreshConnection((native) => {
          const s = getProductionStatus(native);
          return ok({ ...s });
        }),
      ),
    { annotations: { title: 'Production status', readOnlyHint: true } },
  );

  const addItem = tool(
    'sco_add_config_item',
    'Add or update a business host (business service/process/operation) on an SCO production — upserts by config-item NAME (existing item of that name is updated in place, never duplicated) — then applies the change to the running production. The item is added DISABLED by default so the workflow does not start running — enable it separately via sco_enable_config_item once the user confirms. The host class must already be compiled. Pass `settings` for adapter/host settings (e.g. a SQL GenericService\'s DSN/Query/Credentials/JGService/JDBCDriver, or a JavaGateway\'s %gatewayName). Changes the SCO instance.',
    {
      productionName: z.string().describe('Config name of the production, e.g. the active production name.'),
      className: z.string().describe('Fully-qualified compiled host class, e.g. "Workbench.Test.BP".'),
      name: z.string().optional().describe('Config item name (defaults to the class name).'),
      enabled: z
        .boolean()
        .optional()
        .describe('Whether to enable the item. Defaults to false (disabled) — only set true when the user explicitly asks to start/enable it now.'),
      poolSize: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pool size (dedicated jobs). Defaults to 1 so a disabled host is truly idle; 0 shares the Ens.Actor pool and keeps running even when disabled. Set 1 for SQL services (a larger pool processes rows more than once).'),
      settings: z
        .array(
          z.object({
            name: z.string().describe('Setting name, e.g. "DSN", "Query", "Credentials", "%gatewayName".'),
            target: z.enum(['Adapter', 'Host']).optional().describe('Where it applies. Defaults to "Host". Adapter settings (DSN/Query/etc.) use "Adapter".'),
            value: z.string().describe('Setting value.'),
          }),
        )
        .optional()
        .describe('Adapter/host settings to upsert on the item (keyed by name+target, so re-running keeps one row per setting).'),
    },
    async ({ productionName, className, name, enabled, poolSize, settings }) =>
      guard(() =>
        iris.native.withFreshConnection(async (native) => {
          const res = await addOrUpdateConfigItem(native, iris.atelier, {
            productionName,
            className,
            name,
            enabled,
            poolSize,
            settings,
          });
          return res.ok ? ok({ message: res.message }) : fail(res.message);
        }),
      ),
    { annotations: { title: 'Add production item', readOnlyHint: false } },
  );

  const listItems = tool(
    'sco_list_config_items',
    'List the config items (name, class, enabled) on an SCO production. Read-only. Use to check what a data pipeline registered before deleting it, and to ref-count a shared host like the Java Gateway (is any SQL service still using it before you remove it?).',
    { productionName: z.string().describe('Config name of the production, e.g. the active production name.') },
    async ({ productionName }) =>
      guard(() =>
        iris.native.withFreshConnection((native) => {
          const items = listConfigItems(native, productionName);
          return ok({ productionName, count: items.length, items });
        }),
      ),
    { annotations: { title: 'List production items', readOnlyHint: true } },
  );

  const removeItem = tool(
    'sco_remove_config_item',
    'Remove a config item from an SCO production by its config-item NAME, then apply the change to the running production. Use to clean up the hosts a data pipeline registered when the pipeline is deleted. No-op success if the item is not present. Do NOT remove a shared host (e.g. the Java Gateway) unless you have confirmed via sco_list_config_items that nothing else still uses it. Changes the SCO instance.',
    {
      productionName: z.string().describe('Config name of the production, e.g. the active production name.'),
      name: z.string().describe('Config item name to remove.'),
    },
    async ({ productionName, name }) =>
      guard(() =>
        iris.native.withFreshConnection(async (native) => {
          const res = await removeConfigItem(native, iris.atelier, productionName, name);
          return res.ok ? ok({ message: res.message }) : fail(res.message);
        }),
      ),
    { annotations: { title: 'Remove production item', readOnlyHint: false } },
  );

  const enableItem = tool(
    'sco_enable_config_item',
    'Enable or disable an existing config item on the running production and hot-apply it (Ens.Director.EnableConfigItem). Changes the SCO instance.',
    {
      name: z.string().describe('Config item name.'),
      enabled: z.boolean().describe('True to enable, false to disable.'),
    },
    async ({ name, enabled }) =>
      guard(() =>
        iris.native.withFreshConnection((native) => {
          const res = enableConfigItem(native, name, enabled);
          return res.ok ? ok({ message: res.message }) : fail(res.message);
        }),
      ),
    { annotations: { title: 'Enable/disable production item', readOnlyHint: false } },
  );

  const update = tool(
    'sco_update_production',
    'Apply pending configuration changes to the running SCO production (Ens.Director.UpdateProduction) without a stop/start. Changes the SCO instance.',
    {},
    async () =>
      guard(() =>
        iris.native.withFreshConnection((native) => {
          const res = updateProduction(native);
          return res.ok ? ok({ message: res.message }) : fail(res.message);
        }),
      ),
    { annotations: { title: 'Update production', readOnlyHint: false } },
  );

  return [status, addItem, listItems, removeItem, enableItem, update];
}
