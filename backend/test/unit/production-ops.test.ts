import { describe, it, expect } from 'vitest';
import {
  NativeClient,
  type ConnectionFactory,
  type IrisHandle,
  type IrisObject,
} from '../../src/iris/native-client.js';
import {
  getProductionStatus,
  addOrUpdateConfigItem,
  enableConfigItem,
  updateProduction,
  removeConfigItem,
  listConfigItems,
  readConfigItemSettings,
} from '../../src/iris/production-ops.js';

const cfg = { host: 'h', port: 1972, namespace: 'SC', user: 'u', password: 'p' };

function makeClient(handle: Partial<IrisHandle>): NativeClient {
  const iris: IrisHandle = {
    classMethodValue: handle.classMethodValue ?? (() => undefined),
    classMethodVoid: handle.classMethodVoid ?? (() => undefined),
    classMethodObject: handle.classMethodObject ?? (() => null),
  };
  const factory: ConnectionFactory = () => ({
    close: () => {},
    isClosed: () => false,
    createIris: () => iris,
  });
  return new NativeClient(cfg, factory);
}

/** One `Ens.Config.Setting` row (Name/Target/Value), backed by a record bag. */
function fakeSettingRow(rec: Record<string, unknown> = {}): IrisObject {
  return {
    getObject: () => null,
    getString: (p) => String(rec[p] ?? ''),
    set: (p, v) => {
      rec[p] = v;
    },
    invokeValue: () => null,
    invokeString: () => '',
    invokeVoid: () => undefined,
  };
}

/**
 * A fake `Settings` collection over a mutable rows array. Supports the
 * Count/GetAt/Insert surface `applySettings`/`readConfigItemSettings` use, so a
 * setting upserts into the SAME row array the test can inspect afterwards.
 */
function fakeSettings(rows: Record<string, unknown>[]): IrisObject {
  return {
    getObject: () => null,
    getString: () => '',
    set: () => undefined,
    invokeValue: (method, arg) => {
      if (method === 'GetAt') {
        const rec = rows[Number(arg) - 1];
        return rec ? fakeSettingRow(rec) : null;
      }
      return null;
    },
    invokeString: (method) => (method === 'Count' ? String(rows.length) : ''),
    invokeVoid: (method, arg) => {
      if (method === 'Insert' && arg && typeof arg === 'object') {
        const it = arg as IrisObject;
        rows.push({ Name: it.getString('Name'), Target: it.getString('Target'), Value: it.getString('Value') });
      }
    },
  };
}

/**
 * A fake Ens.Config.Item oref backed by a plain property bag. Its `Settings`
 * collection is backed by `props._settings` (created on demand) so a settings
 * upsert persists on the record and the test can read it back.
 */
function fakeItem(props: Record<string, unknown> = {}): IrisObject {
  return {
    getObject: (p) => {
      if (p !== 'Settings') return null;
      const rows = (props._settings as Record<string, unknown>[] | undefined) ?? [];
      props._settings = rows;
      return fakeSettings(rows);
    },
    getString: (p) => String(props[p] ?? ''),
    set: (p, v) => {
      props[p] = v;
    },
    invokeValue: () => null,
    invokeString: () => '1',
    invokeVoid: () => undefined,
  };
}

/**
 * A fake Ens.Config.Production oref with an in-memory item list. Records the
 * final saved state so tests can assert what was persisted.
 */
function fakeProduction(items: Record<string, unknown>[]): {
  oref: IrisObject;
  items: Record<string, unknown>[];
  saved: { count: number };
  savedToClass: { count: number };
} {
  const saved = { count: 0 };
  // Tracks SaveToClass calls; the production ops must NOT call it (recompiling
  // the class restarts all hosts), so this should stay 0.
  const savedToClass = { count: 0 };
  const itemsCollection: IrisObject = {
    getObject: () => null,
    getString: () => '',
    set: () => undefined,
    // GetAt(i) → the i-th item as an oref (for listConfigItems iteration).
    invokeValue: (method, arg) => {
      if (method === 'GetAt') {
        const rec = items[Number(arg) - 1];
        return rec ? fakeItem(rec) : null;
      }
      return null;
    },
    invokeString: (method) => (method === 'Count' ? String(items.length) : ''),
    // Insert(item) — record the newly-created item's props (incl. its settings).
    invokeVoid: (method, arg) => {
      if (method === 'Insert' && arg && typeof arg === 'object') {
        const bag: Record<string, unknown> = {};
        // Read back the props the caller set on the fresh item.
        const it = arg as IrisObject;
        for (const key of ['Name', 'ClassName', 'Enabled', 'PoolSize']) {
          const v = it.getString(key);
          if (v !== '') bag[key] = v;
        }
        // Preserve any settings applied before insert (SQL DSN/Query/etc.).
        const coll = it.getObject('Settings') as IrisObject | null;
        if (coll) {
          const count = Number(coll.invokeString('Count')) || 0;
          const rows: Record<string, unknown>[] = [];
          for (let i = 1; i <= count; i++) {
            const row = coll.invokeValue('GetAt', i) as IrisObject | null;
            if (row) rows.push({ Name: row.getString('Name'), Target: row.getString('Target'), Value: row.getString('Value') });
          }
          if (rows.length) bag._settings = rows;
        }
        items.push(bag);
      }
    },
  };
  const oref: IrisObject = {
    getObject: (p) => (p === 'Items' ? itemsCollection : null),
    getString: () => '',
    set: () => undefined,
    invokeValue: (method, name) => {
      if (method === 'FindItemByConfigName') {
        const found = items.find((i) => i.Name === name);
        return found ? fakeItem(found) : null;
      }
      return null;
    },
    invokeString: (method) => {
      if (method === '%Save') {
        saved.count += 1;
        return '1';
      }
      // SaveToClass writes the item list into the production class XData; we
      // must call it after %Save so runtime and class stay consistent (else the
      // Portal reports #5001). Return a success %Status so the op continues.
      if (method === 'SaveToClass') {
        savedToClass.count += 1;
        return '1';
      }
      if (method === 'RemoveItem') return '1';
      return '';
    },
    invokeVoid: (method, arg) => {
      if (method === 'RemoveItem' && arg) {
        // Remove by matching the item's Name.
        const target = arg as IrisObject;
        const nm = target.getString('Name');
        const idx = items.findIndex((i) => i.Name === nm);
        if (idx >= 0) items.splice(idx, 1);
      }
    },
  };
  return { oref, items, saved, savedToClass };
}

describe('getProductionStatus', () => {
  it('reports running when state is 1', () => {
    const client = makeClient({
      classMethodValue: (_cls, method) => {
        if (method === 'GetActiveProductionName') return 'My.Prod';
        if (method === 'GetProductionStatus') return 1;
        return undefined;
      },
    });
    const status = getProductionStatus(client);
    expect(status).toMatchObject({ productionName: 'My.Prod', state: 1, running: true, stateLabel: 'Running' });
  });

  it('reports no production / stopped when none is active', () => {
    const client = makeClient({
      classMethodValue: (_cls, method) => {
        if (method === 'GetActiveProductionName') return '';
        if (method === 'GetProductionStatus') return 0;
        return undefined;
      },
    });
    const status = getProductionStatus(client);
    expect(status.productionName).toBeNull();
    expect(status.running).toBe(false);
  });

  // The labels are the $$$eProductionState* codes from EnsConstants.INC. State 2
  // is what a clean StopProduction leaves behind, so calling it "Suspended" (the
  // code for 3) would misreport the ordinary stopped case.
  it.each([
    [0, 'Unknown'],
    [2, 'Stopped'],
    [3, 'Suspended'],
    [4, 'Troubled'],
    [5, 'NetworkStopped'],
  ])('labels state %i as %s', (state, label) => {
    const client = makeClient({
      classMethodValue: (_cls, method) => {
        if (method === 'GetActiveProductionName') return 'My.Prod';
        if (method === 'GetProductionStatus') return state;
        return undefined;
      },
    });
    const status = getProductionStatus(client);
    expect(status.stateLabel).toBe(label);
    expect(status.running).toBe(false);
  });
});

/**
 * Wire a NativeClient whose class-method calls resolve against a fake
 * production oref. `%OpenId` returns the production (or null when
 * `productionExists` is false); `UpdateProduction` succeeds; `NameExists`
 * reflects the live item list; `Ens.Config.Item %New` returns a fresh item.
 */
function makeProdClient(
  prod: ReturnType<typeof fakeProduction>,
  opts: { productionExists?: boolean; running?: boolean; updateCalls?: { count: number } } = {},
): NativeClient {
  const exists = opts.productionExists ?? true;
  const running = opts.running ?? true;
  return makeClient({
    classMethodValue: (cls, method, ...args) => {
      if (cls === 'Ens.Config.Item' && method === 'NameExists') {
        const name = args[1];
        return prod.items.some((i) => i.Name === name) ? '1' : '0';
      }
      // Reflect a running production so applyToRunningProduction actually
      // reconciles (otherwise it short-circuits regardless of enabled).
      if (method === 'GetActiveProductionName') return running ? 'My.Prod' : '';
      if (method === 'GetProductionStatus') return running ? 1 : 0;
      if (method === 'UpdateProduction') {
        if (opts.updateCalls) opts.updateCalls.count += 1;
        return 1;
      }
      // Up-to-date after the reconcile (0 = no pending update), so the add path
      // reports "applied" without entering the settle-retry loop.
      if (method === 'ProductionNeedsUpdate') return 0;
      return undefined;
    },
    classMethodObject: (cls, method) => {
      if (cls === 'Ens.Config.Production' && method === '%OpenId') return exists ? prod.oref : null;
      if (cls === 'Ens.Config.Item' && method === '%New') return fakeItem();
      if (cls === 'Ens.Config.Setting' && method === '%New') return fakeSettingRow();
      return null;
    },
  });
}

describe('addOrUpdateConfigItem (object API)', () => {
  it('inserts a new item enabled and reconciles the running production once', async () => {
    const prod = fakeProduction([]);
    const updateCalls = { count: 0 };
    const client = makeProdClient(prod, { updateCalls });

    const res = await addOrUpdateConfigItem(client, undefined, {
      productionName: 'My.Prod',
      className: 'Workbench.Test.BP',
      enabled: true,
    });

    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/added to .* and enabled/);
    expect(prod.saved.count).toBe(1);
    // %Save persists to the runtime config store; SaveToClass must NOT be called
    // (it recompiles the production class and restarts every host).
    expect(prod.savedToClass.count).toBe(0);
    // An enabled add reconciles the running production exactly once.
    expect(updateCalls.count).toBe(1);
    expect(prod.items).toHaveLength(1);
    // The insert path reads props back via getString, so values are strings.
    expect(prod.items[0]).toMatchObject({ ClassName: 'Workbench.Test.BP', Enabled: '1' });
  });

  it('adds the item disabled by default and STILL reconciles the running production', async () => {
    const prod = fakeProduction([]);
    const updateCalls = { count: 0 };
    const client = makeProdClient(prod, { updateCalls });

    const res = await addOrUpdateConfigItem(client, undefined, {
      productionName: 'My.Prod',
      className: 'Workbench.Test.BP',
      // enabled intentionally omitted → defaults to disabled
    });

    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/disabled/);
    expect(res.message).toMatch(/will not run until you start\/enable it/);
    // The config is persisted to the runtime store (no SaveToClass recompile)...
    expect(prod.saved.count).toBe(1);
    expect(prod.savedToClass.count).toBe(0);
    // ...AND a disabled add must reconcile the running production exactly once.
    // %Save + SaveToClass only change stored config; without an UpdateProduction
    // the running production stays "out of date" (the Portal's red Update button)
    // and its queueInfo panel 500s with "No queue found for this item". A disabled
    // host on a dedicated pool has nothing to start/stop, so this reconcile is a
    // safe, instant no-op on the other hosts.
    expect(updateCalls.count).toBe(1);
    // Disabled AND on a dedicated pool (PoolSize 1) — a PoolSize-0 host shares
    // the Ens.Actor pool and keeps processing even when disabled.
    expect(prod.items[0]).toMatchObject({ ClassName: 'Workbench.Test.BP', Enabled: '0', PoolSize: '1' });
  });

  it('preserves existing items when adding a new one', async () => {
    const prod = fakeProduction([
      { Name: 'Existing1', ClassName: 'A.One', Enabled: 1 },
      { Name: 'Existing2', ClassName: 'A.Two', Enabled: 1 },
    ]);
    const client = makeProdClient(prod);

    const res = await addOrUpdateConfigItem(client, undefined, {
      productionName: 'My.Prod',
      className: 'Workbench.Test.BP',
    });

    expect(res.ok, res.message).toBe(true);
    // Original two untouched + the new one.
    expect(prod.items.map((i) => i.Name)).toEqual(['Existing1', 'Existing2', 'Workbench.Test.BP']);
  });

  it('updates an existing item in place instead of duplicating it', async () => {
    const prod = fakeProduction([
      { Name: 'Workbench.Test.BP', ClassName: 'Workbench.Test.BP', Enabled: 1 },
    ]);
    const client = makeProdClient(prod);

    const res = await addOrUpdateConfigItem(client, undefined, {
      productionName: 'My.Prod',
      className: 'Workbench.Test.BP',
      enabled: false,
    });
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/updated on/);
    // Still one item; its Enabled flipped to 0 in place.
    expect(prod.items).toHaveLength(1);
    expect(prod.items[0]).toMatchObject({ Name: 'Workbench.Test.BP', Enabled: 0 });
  });

  it('fails cleanly when the production does not exist', async () => {
    const prod = fakeProduction([]);
    const client = makeProdClient(prod, { productionExists: false });
    const res = await addOrUpdateConfigItem(client, undefined, { productionName: 'Nope', className: 'X' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not found/);
  });

  it('applies adapter/host settings onto a NEW item (SQL GenericService)', async () => {
    const prod = fakeProduction([]);
    const client = makeProdClient(prod);
    const res = await addOrUpdateConfigItem(client, undefined, {
      productionName: 'My.Prod',
      className: 'EnsLib.SQL.Service.GenericService',
      name: 'SC.Workbench.BS.Service.CustomerService',
      poolSize: 1,
      settings: [
        { name: 'DSN', target: 'Adapter', value: 'jdbc:IRIS://h:1972/SC' },
        { name: 'Query', target: 'Adapter', value: 'SELECT * FROM orders' },
        { name: 'MessageClass', target: 'Host', value: 'SC.Workbench.BP.Message.CustomerRequest' },
      ],
    });
    expect(res.ok, res.message).toBe(true);
    const settings = readConfigItemSettings(client, 'My.Prod', 'SC.Workbench.BS.Service.CustomerService');
    expect(settings).toEqual(
      expect.arrayContaining([
        { name: 'DSN', target: 'Adapter', value: 'jdbc:IRIS://h:1972/SC' },
        { name: 'Query', target: 'Adapter', value: 'SELECT * FROM orders' },
        { name: 'MessageClass', target: 'Host', value: 'SC.Workbench.BP.Message.CustomerRequest' },
      ]),
    );
  });

  it('UPSERTS a setting by (name, target) instead of appending a duplicate on re-deploy', async () => {
    // Pre-existing item already carries a DSN and a Query.
    const prod = fakeProduction([
      {
        Name: 'SqlSvc',
        ClassName: 'EnsLib.SQL.Service.GenericService',
        Enabled: 0,
        _settings: [
          { Name: 'DSN', Target: 'Adapter', Value: 'jdbc:old' },
          { Name: 'Query', Target: 'Adapter', Value: 'SELECT 1' },
        ],
      },
    ]);
    const client = makeProdClient(prod);

    const res = await addOrUpdateConfigItem(client, undefined, {
      productionName: 'My.Prod',
      className: 'EnsLib.SQL.Service.GenericService',
      name: 'SqlSvc',
      // Change the DSN, keep the same Query, add a new Credentials setting.
      settings: [
        { name: 'DSN', target: 'Adapter', value: 'jdbc:new' },
        { name: 'Credentials', target: 'Adapter', value: 'MyCreds' },
      ],
    });
    expect(res.ok, res.message).toBe(true);

    const settings = readConfigItemSettings(client, 'My.Prod', 'SqlSvc');
    // DSN updated in place (no duplicate), Query preserved, Credentials added.
    const dsn = settings.filter((s) => s.name === 'DSN');
    expect(dsn, 'DSN not duplicated').toHaveLength(1);
    expect(dsn[0]!.value).toBe('jdbc:new');
    expect(settings.find((s) => s.name === 'Query')?.value).toBe('SELECT 1');
    expect(settings.find((s) => s.name === 'Credentials')?.value).toBe('MyCreds');
    expect(settings).toHaveLength(3);
  });

  it('treats the same setting name under a different Target as a distinct row', async () => {
    const prod = fakeProduction([
      { Name: 'Svc', ClassName: 'X', Enabled: 0, _settings: [{ Name: 'JGService', Target: 'Host', Value: 'JavaGateway' }] },
    ]);
    const client = makeProdClient(prod);
    await addOrUpdateConfigItem(client, undefined, {
      productionName: 'My.Prod',
      className: 'X',
      name: 'Svc',
      // Same NAME "JGService" but Target Adapter — must NOT overwrite the Host one.
      settings: [{ name: 'JGService', target: 'Adapter', value: 'JavaGateway' }],
    });
    const settings = readConfigItemSettings(client, 'My.Prod', 'Svc');
    expect(settings.filter((s) => s.name === 'JGService')).toHaveLength(2);
    expect(settings.find((s) => s.name === 'JGService' && s.target === 'Host')?.value).toBe('JavaGateway');
    expect(settings.find((s) => s.name === 'JGService' && s.target === 'Adapter')?.value).toBe('JavaGateway');
  });
});

describe('listConfigItems', () => {
  it('lists every item with name, class, and enabled flag', () => {
    const prod = fakeProduction([
      { Name: 'JavaGateway', ClassName: 'EnsLib.JavaGateway.Service', Enabled: '1' },
      { Name: 'SqlA', ClassName: 'EnsLib.SQL.Service.GenericService', Enabled: '0' },
      { Name: 'SqlB', ClassName: 'EnsLib.SQL.Service.GenericService', Enabled: '1' },
    ]);
    const client = makeProdClient(prod);
    const items = listConfigItems(client, 'My.Prod');
    expect(items).toEqual([
      { name: 'JavaGateway', className: 'EnsLib.JavaGateway.Service', enabled: true },
      { name: 'SqlA', className: 'EnsLib.SQL.Service.GenericService', enabled: false },
      { name: 'SqlB', className: 'EnsLib.SQL.Service.GenericService', enabled: true },
    ]);
  });

  it('returns [] when the production cannot be opened', () => {
    const prod = fakeProduction([]);
    const client = makeProdClient(prod, { productionExists: false });
    expect(listConfigItems(client, 'Nope')).toEqual([]);
  });

  it('supports ref-counting the shared Java Gateway before removal', () => {
    // Two SQL services share one gateway. After removing SqlA, the other SQL
    // service remains → the gateway must be KEPT. The skill drives this by
    // counting GenericService items excluding the one being removed.
    const prod = fakeProduction([
      { Name: 'JavaGateway', ClassName: 'EnsLib.JavaGateway.Service', Enabled: '1' },
      { Name: 'SqlA', ClassName: 'EnsLib.SQL.Service.GenericService', Enabled: '1' },
      { Name: 'SqlB', ClassName: 'EnsLib.SQL.Service.GenericService', Enabled: '1' },
    ]);
    const client = makeProdClient(prod);
    const items = listConfigItems(client, 'My.Prod');
    const otherSql = items.filter(
      (i) => i.className === 'EnsLib.SQL.Service.GenericService' && i.name !== 'SqlA',
    );
    expect(otherSql.map((i) => i.name)).toEqual(['SqlB']); // → keep the gateway
  });
});

describe('readConfigItemSettings', () => {
  it('returns [] for a missing item', () => {
    const prod = fakeProduction([{ Name: 'Other', ClassName: 'X', Enabled: '1' }]);
    const client = makeProdClient(prod);
    expect(readConfigItemSettings(client, 'My.Prod', 'Ghost')).toEqual([]);
  });
});

describe('enableConfigItem', () => {
  it('calls EnableConfigItem(name, 1, 1) to hot-enable', () => {
    const calls: unknown[][] = [];
    const client = makeClient({
      classMethodValue: (_cls, method, ...args) => {
        calls.push([method, ...args]);
        return method === 'EnableConfigItem' ? 1 : undefined;
      },
    });
    const res = enableConfigItem(client, 'BPItem', true);
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual(['EnableConfigItem', 'BPItem', 1, 1]);
  });

  it('on ErrJobNotStopped, SETTLES the production (retries UpdateProduction until up-to-date) and reports it applied', () => {
    // First ProductionNeedsUpdate check → 1 (pending); after a retry UpdateProduction → 0 (settled).
    let needsUpdateCalls = 0;
    const seen: string[] = [];
    const client = makeClient({
      classMethodValue: (_cls, method, ...args) => {
        seen.push(method);
        if (method === 'EnableConfigItem') return 'STATUS_JOBNOTSTOPPED';
        if (method === 'GetErrorText' && args[0] === 'STATUS_JOBNOTSTOPPED') {
          return "ERROR <Ens>ErrJobNotStopped: Job '504' failed to stop within 10 seconds";
        }
        if (method === 'ProductionNeedsUpdate') {
          needsUpdateCalls++;
          return needsUpdateCalls === 1 ? 1 : 0; // pending first, settled after the retry
        }
        if (method === 'UpdateProduction') return 1;
        return undefined;
      },
    });
    const res = enableConfigItem(client, 'BPItem', true);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/applied to the running production/i);
    expect(seen).toContain('UpdateProduction'); // it actually did the Update work
  });

  it('on ErrJobNotStopped that NEVER settles, reports the honest "not live yet" truth (still ok, but not claiming applied)', () => {
    const client = makeClient({
      classMethodValue: (_cls, method, ...args) => {
        if (method === 'EnableConfigItem') return 'STATUS_JOBNOTSTOPPED';
        if (method === 'GetErrorText' && args[0] === 'STATUS_JOBNOTSTOPPED') {
          return "ERROR <Ens>ErrJobNotStopped: Job '504' failed to stop within 10 seconds";
        }
        if (method === 'ProductionNeedsUpdate') return 1; // always pending → never settles
        if (method === 'UpdateProduction') return 'STATUS_STILLBUSY';
        if (method === 'GetErrorText' && args[0] === 'STATUS_STILLBUSY') return 'ErrJobNotStopped again';
        return undefined;
      },
    });
    const res = enableConfigItem(client, 'BPItem', true);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/could not be brought up-to-date|slow\/stuck stopping/i);
    expect(res.message).not.toMatch(/applied to the running production/i);
  });

  it('treats "already enabled" as idempotent success', () => {
    const client = makeClient({
      classMethodValue: (_cls, method, ...args) => {
        if (method === 'EnableConfigItem') return 'STATUS_ALREADY';
        if (method === 'GetErrorText' && args[0] === 'STATUS_ALREADY') {
          return 'ERROR <Ens>ErrGeneral: Item BPItem already enabled in Production My.Prod';
        }
        return undefined;
      },
    });
    const res = enableConfigItem(client, 'BPItem', true);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/already enabled/i);
  });

  it('still reports a genuine enable failure as ok:false', () => {
    const client = makeClient({
      classMethodValue: (_cls, method, ...args) => {
        if (method === 'EnableConfigItem') return 'STATUS_BADITEM';
        if (method === 'GetErrorText' && args[0] === 'STATUS_BADITEM') {
          return 'ERROR <Ens>ErrConfigItemNotFound: No such item';
        }
        return undefined;
      },
    });
    const res = enableConfigItem(client, 'Ghost', true);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Failed to enable/i);
  });
});

describe('updateProduction', () => {
  it('calls UpdateProduction(10, 0)', () => {
    const calls: unknown[][] = [];
    const client = makeClient({
      classMethodValue: (_cls, method, ...args) => {
        calls.push([method, ...args]);
        return 1;
      },
    });
    expect(updateProduction(client).ok).toBe(true);
    expect(calls[0]).toEqual(['UpdateProduction', 10, 0]);
  });
});

describe('removeConfigItem (object API)', () => {
  it('is a no-op success when the item is absent', async () => {
    const prod = fakeProduction([{ Name: 'Other', ClassName: 'A.X', Enabled: 1 }]);
    const client = makeProdClient(prod);
    const res = await removeConfigItem(client, undefined, 'My.Prod', 'Ghost');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/nothing to remove/);
    expect(prod.items).toHaveLength(1);
  });

  it('is a no-op success when the production does not exist', async () => {
    const prod = fakeProduction([]);
    const client = makeProdClient(prod, { productionExists: false });
    const res = await removeConfigItem(client, undefined, 'Nope', 'BPItem');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/not found/);
  });

  it('removes a present item and preserves the others', async () => {
    const prod = fakeProduction([
      { Name: 'Keep', ClassName: 'A.Keep', Enabled: 1 },
      { Name: 'BPItem', ClassName: 'Workbench.Test.BP', Enabled: 1 },
    ]);
    const client = makeProdClient(prod);
    const res = await removeConfigItem(client, undefined, 'My.Prod', 'BPItem');
    expect(res.ok, res.message).toBe(true);
    expect(prod.items.map((i) => i.Name)).toEqual(['Keep']);
    expect(prod.saved.count).toBe(1);
    // Removal persists via %Save only — no SaveToClass recompile.
    expect(prod.savedToClass.count).toBe(0);
  });
});
