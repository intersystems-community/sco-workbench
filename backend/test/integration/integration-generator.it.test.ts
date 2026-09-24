/**
 * Integration test for the deterministic data-integration class generator.
 *
 * The whole reason the generator exists is that hand-authored pipeline classes
 * kept failing to compile (stray Storage block, %CSV.Reader, a <call> to the DTL,
 * create="new", …). So the only test that really proves it works is one that
 * FILLS a definition, generates the classes, and COMPILES them in a live IRIS —
 * over a real target class — asserting every class compiles and the config-item
 * plan is what sco_add_config_item expects. This is that test.
 *
 * Live IRIS required; run via the path-scoped script: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, type BootedApp } from './helpers/iris-app.js';
import { createCustomObject, runCleanups, uniqueSuffix, type Cleanup } from './helpers/provision.js';
import { sweep } from './helpers/sweep.js';
import {
  generateIntegrationClasses,
  generateConfigItems,
  sanitizeIntegrationName,
  integrationClassNames,
} from '../../src/integration/integration-generator.js';
import type { IntegrationDefinition } from '../../src/integration/integration-definition.model.js';
import { listMethods } from '../../src/iris/schema-ops.js';

const d = describe;

d('data-integration generator → compiles in IRIS', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(() => {
    app = bootApp();
    cleanups = [];
  });

  afterAll(async () => {
    await runCleanups(cleanups);
    await sweep(app.iris);
    await app.close();
  });

  /** Delete a generated class from IRIS (tolerant of absence). */
  function deleteClass(className: string): void {
    try {
      app.iris.native.callValue('%SYSTEM.OBJ', 'Delete', className, 'd-d');
    } catch {
      /* already gone */
    }
  }

  /**
   * Generate the pipeline classes for `def` and compile each (in the returned
   * order) via the real Atelier import+compile path. Registers a cleanup for each
   * class and asserts every one compiles.
   */
  async function generateAndCompile(def: IntegrationDefinition): Promise<void> {
    const classes = generateIntegrationClasses(def);
    for (const cls of classes) {
      if (cls.source === null) continue; // SQL BS: no class to compile
      cleanups.push(() => deleteClass(cls.className));
      const res = await app.iris.atelier.importAndCompile(cls.className, cls.source);
      expect(res.ok, `${cls.role} ${cls.className} failed to compile: ${JSON.stringify(res.errors ?? res.console)}`).toBe(
        true,
      );
    }
  }

  it('File + header CSV: message/DTL/BPL/BS all compile against a real custom object (upsert on uid)', async () => {
    // A brand-new custom object so we control the target (and it has a uid key index).
    const obj = await createCustomObject(app, [
      { name: 'name', dataType: 'String' },
      { name: 'type', dataType: 'String' },
      { name: 'status', dataType: 'String' },
    ]);
    cleanups.push(obj.cleanup);
    expect(obj.props).toContain('uid');

    // The backend's key-index discovery (same logic the tool runs): uidIndexOpen
    // exists. It's generated as an instance-flagged method on a custom class but
    // is callable as ##class(Cls).uidIndexOpen(v) — so match by name only.
    const methods = await listMethods(app.iris.atelier, obj.className);
    const hasUidOpen = methods.some((m) => m.name === 'uidIndexOpen');
    expect(hasUidOpen, 'custom object should expose uidIndexOpen for the upsert').toBe(true);

    const def: IntegrationDefinition = {
      id: `it${uniqueSuffix()}`,
      name: 'CustFileFlow',
      adapter: 'File',
      service: { filePath: '/tmp/sco-workbench/csv', fileSpec: 'x_customers.csv' },
      process: {
        hasHeader: true,
        targetClass: obj.className,
        mappings: [
          { sourceField: 'ID', sourceType: 'string', targetProperty: 'uid' },
          { sourceField: 'Name', sourceType: 'string', transform: 'ToUpper', targetProperty: 'name' },
          { sourceField: 'Type', sourceType: 'string', targetProperty: 'type' },
          { sourceField: 'Status', sourceType: 'string', targetProperty: 'status' },
        ],
      },
      keyIndex: 'uidIndex',
      keyRequestProp: 'ID',
    };

    await generateAndCompile(def);

    // The config-item plan is [BP, BS], both disabled, BS with no settings.
    const items = generateConfigItems(def);
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    expect(items.map((i) => i.className)).toEqual([names.bpConfigName, names.bsConfigName]);
    expect(items[1]!.settings).toEqual([]);
  });

  it('File + no header: positional CSV parse compiles', async () => {
    const obj = await createCustomObject(app, [{ name: 'name', dataType: 'String' }]);
    cleanups.push(obj.cleanup);

    const def: IntegrationDefinition = {
      id: `it${uniqueSuffix()}`,
      name: 'NoHeaderFlow',
      adapter: 'File',
      service: { filePath: '/tmp/sco-workbench/csv', fileSpec: '*.csv' },
      process: {
        hasHeader: false,
        targetClass: obj.className,
        mappings: [
          { sourceField: 'Col1', targetProperty: 'uid' },
          { sourceField: 'Col2', targetProperty: 'name' },
        ],
      },
      keyIndex: 'uidIndex',
      keyRequestProp: 'Col1',
    };
    await generateAndCompile(def);
  });

  it('SFTP: EnsLib.FTP.InboundAdapter service + BP/DTL/message compile', async () => {
    const obj = await createCustomObject(app, [{ name: 'name', dataType: 'String' }]);
    cleanups.push(obj.cleanup);

    const def: IntegrationDefinition = {
      id: `it${uniqueSuffix()}`,
      name: 'SftpFlow',
      adapter: 'SFTP',
      service: { host: 'sftp.example.com', port: 22, path: '/in', credentials: 'DummyCreds', fileSpec: '*.csv' },
      process: {
        hasHeader: true,
        targetClass: obj.className,
        mappings: [
          { sourceField: 'ID', targetProperty: 'uid' },
          { sourceField: 'Name', targetProperty: 'name' },
        ],
      },
      keyIndex: 'uidIndex',
      keyRequestProp: 'ID',
    };
    await generateAndCompile(def);
  });

  it('Cloud (S3): EnsLib.AmazonS3.InboundAdapter service + BP/DTL/message compile', async () => {
    const obj = await createCustomObject(app, [{ name: 'name', dataType: 'String' }]);
    cleanups.push(obj.cleanup);

    const def: IntegrationDefinition = {
      id: `it${uniqueSuffix()}`,
      name: 'CloudFlow',
      adapter: 'Cloud',
      service: { bucket: 'my-bucket', region: 'us-east-1', blobPattern: '*.csv' },
      process: {
        hasHeader: true,
        targetClass: obj.className,
        mappings: [
          { sourceField: 'ID', targetProperty: 'uid' },
          { sourceField: 'Name', targetProperty: 'name' },
        ],
      },
      keyIndex: 'uidIndex',
      keyRequestProp: 'ID',
    };
    await generateAndCompile(def);
  });

  it('SQL: message/DTL/BPL compile (no BS class), config plan has JavaGateway + GenericService', async () => {
    const obj = await createCustomObject(app, [{ name: 'name', dataType: 'String' }]);
    cleanups.push(obj.cleanup);

    // The source table's key (srcId) is NOT mapped to any target property — the
    // target auto-generates its own key. The query selects srcId so the adapter
    // can track rows by it; the message must carry a srcId property for it.
    const def: IntegrationDefinition = {
      id: `it${uniqueSuffix()}`,
      name: 'SqlFlow',
      adapter: 'SQL',
      service: { dsn: 'jdbc:IRIS://host:1972/SC', query: 'SELECT Name, srcId FROM t', credentials: 'DbCreds', keyField: 'srcId' },
      process: {
        hasHeader: true,
        targetClass: obj.className,
        mappings: [{ sourceField: 'Name', targetProperty: 'name' }],
      },
      keyIndex: 'uidIndex',
      keyRequestProp: undefined,
    };
    await generateAndCompile(def); // BS source is null → skipped; message/DTL/BPL compile

    const items = generateConfigItems(def);
    expect(items.map((i) => i.className)).toEqual([
      integrationClassNames(def.id, sanitizeIntegrationName(def.name)).bpConfigName,
      'EnsLib.JavaGateway.Service',
      'EnsLib.SQL.Service.GenericService',
    ]);
    // The GenericService carries the exact settings the pre-built service needs,
    // including KeyFieldName set to the SOURCE key column (not the "ID" default).
    const gs = items[2]!;
    const byName = Object.fromEntries(gs.settings.map((s) => [s.name, s]));
    expect(byName['DSN']?.target).toBe('Adapter');
    expect(byName['TargetConfigNames']?.value).toBe(items[0]!.className);
    expect(byName['MessageClass']?.value).toContain('.Message.');
    expect(byName['KeyFieldName']?.value).toBe('srcId');
  });

  it('insert-only fallback compiles when no key index is provided', async () => {
    const obj = await createCustomObject(app, [{ name: 'name', dataType: 'String' }]);
    cleanups.push(obj.cleanup);

    const def: IntegrationDefinition = {
      id: `it${uniqueSuffix()}`,
      name: 'InsertOnlyFlow',
      adapter: 'File',
      service: { filePath: '/tmp/sco-workbench/csv', fileSpec: '*.csv' },
      process: {
        hasHeader: true,
        targetClass: obj.className,
        mappings: [{ sourceField: 'Name', targetProperty: 'name' }],
      },
      // no keyIndex / keyRequestProp → BPL always %New()s
    };
    await generateAndCompile(def);
  });

  it('FK-aware BPL (with a foreignKeys entry) compiles — the #5829 skip logging is valid ObjectScript', async () => {
    const obj = await createCustomObject(app, [
      { name: 'name', dataType: 'String' },
      { name: 'loc', dataType: 'String' },
    ]);
    cleanups.push(obj.cleanup);

    // The custom object has no real FK, but the generator emits FK-aware catchall
    // code whenever `foreignKeys` is populated — this proves that generated code
    // (string concat over request.<field> inside the CDATA) compiles in IRIS.
    const def: IntegrationDefinition = {
      id: `it${uniqueSuffix()}`,
      name: 'FkFlow',
      adapter: 'File',
      service: { filePath: '/tmp/sco-workbench/csv', fileSpec: '*.csv' },
      process: {
        hasHeader: true,
        targetClass: obj.className,
        mappings: [
          { sourceField: 'Name', targetProperty: 'name' },
          { sourceField: 'Loc', targetProperty: 'loc' },
        ],
      },
      keyIndex: 'uidIndex',
      keyRequestProp: 'Name',
      foreignKeys: [{ name: 'locFK', referencedClass: 'SC.Data.Location', sourceFields: ['Loc'] }],
    };
    await generateAndCompile(def);
  });

  it('sco_generate_integration_classes surfaces target FK prerequisites as warnings', async () => {
    // Against the REAL SC.Data.Customer (which has primaryLocationId/shipToLocationId
    // FKs → SC.Data.Location), generating a pipeline that writes an FK column must
    // return a warning naming the referenced class.
    const { integrationTools } = await import('../../src/tools/integration-tools.js');
    const tool = integrationTools(app.iris).find((t) => t.name === 'sco_generate_integration_classes')!;
    const res = await tool.handler(
      {
        definition: {
          id: `it${uniqueSuffix()}`,
          name: 'CustFk',
          adapter: 'File',
          service: { filePath: '/tmp/x', fileSpec: '*.csv' },
          process: {
            hasHeader: true,
            targetClass: 'SC.Data.Customer',
            mappings: [
              { sourceField: 'ID', targetProperty: 'uid' },
              { sourceField: 'Loc', targetProperty: 'primaryLocationId' },
            ],
          },
        },
      } as never,
      undefined as never,
    );
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.foreignKeys.some((fk: { referencedClass: string }) => fk.referencedClass === 'SC.Data.Location')).toBe(true);
    expect(payload.warnings.join(' ')).toMatch(/SC\.Data\.Location/);
    expect(payload.warnings.join(' ')).toMatch(/5829|foreign key/i);
  });
});
