import { describe, it, expect } from 'vitest';
import {
  generateIntegrationClasses,
  generateConfigItems,
  generateMessageClass,
  generateDtlClass,
  generateBplClass,
  generateBusinessServiceClass,
  validateIntegrationDefinition,
  sanitizeIntegrationName,
  integrationClassNames,
} from '../../src/integration/integration-generator.js';
import type { IntegrationDefinition } from '../../src/integration/integration-definition.model.js';

/** A representative File-adapter definition (the customers→SC.Data.Customer case). */
function fileDef(overrides: Partial<IntegrationDefinition> = {}): IntegrationDefinition {
  return {
    id: 'job123',
    name: 'test3',
    adapter: 'File',
    service: { filePath: '/tmp/sco-workbench/csv', fileSpec: 'abc_customers.csv' },
    process: {
      hasHeader: true,
      targetClass: 'SC.Data.Customer',
      mappings: [
        { sourceField: 'ID', sourceType: 'string', targetProperty: 'uid' },
        { sourceField: 'Name', sourceType: 'string', targetProperty: 'name' },
        { sourceField: 'Type', sourceType: 'string', targetProperty: 'type' },
      ],
    },
    keyIndex: 'uidIndex',
    keyRequestProp: 'ID',
    ...overrides,
  };
}

describe('sanitizeIntegrationName', () => {
  it('strips punctuation/space and PascalCase-safe leading char', () => {
    expect(sanitizeIntegrationName('ERP Orders')).toBe('ERPOrders');
    expect(sanitizeIntegrationName('3-way sync')).toBe('P3waysync');
    expect(sanitizeIntegrationName('')).toBe('Integration');
    expect(sanitizeIntegrationName('test3')).toBe('test3');
  });
});

describe('integrationClassNames', () => {
  it('derives the four names under the per-integration package', () => {
    const n = integrationClassNames('job123', 'Test3');
    expect(n).toEqual({
      requestClass: 'SC.Workbench.Integrationjob123.Message.Test3Request',
      dtlClass: 'SC.Workbench.Integrationjob123.DTL.Test3Transformation',
      bpConfigName: 'SC.Workbench.Integrationjob123.BP.Test3Process',
      bsConfigName: 'SC.Workbench.Integrationjob123.BS.Test3Service',
    });
  });
});

describe('generateMessageClass', () => {
  it('emits one property per mapping, no Storage block, no extra members', () => {
    const def = fileDef();
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateMessageClass(def, names);
    expect(src).toContain('Extends Ens.Request');
    expect(src).toContain('Property ID As %String;');
    expect(src).toContain('Property Name As %String;');
    expect(src).toContain('Property Type As %String;');
    // The bugs we must never regress:
    expect(src).not.toMatch(/Storage/);
    expect(src).not.toMatch(/XData/);
  });

  it('maps source type tokens to IRIS types', () => {
    const def = fileDef({
      process: {
        hasHeader: true,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'Qty', sourceType: 'integer', targetProperty: 'qty' },
          { sourceField: 'Price', sourceType: 'decimal', targetProperty: 'price' },
          { sourceField: 'When', sourceType: 'datetime', targetProperty: 'ts' },
        ],
      },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateMessageClass(def, names);
    expect(src).toContain('Property Qty As %Integer;');
    expect(src).toContain('Property Price As %Decimal;');
    expect(src).toContain('Property When As %TimeStamp;');
  });
});

describe('generateDtlClass', () => {
  it('always uses create=existing (upsert), never new', () => {
    const def = fileDef();
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateDtlClass(def, names);
    expect(src).toContain("create='existing'");
    expect(src).not.toContain("create='new'");
    expect(src).toContain("<assign value='source.ID' property='target.uid' action='set' />");
  });

  it('emits transform functions with positional args, numbers bare and strings quoted', () => {
    const def = fileDef({
      process: {
        hasHeader: true,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'Name', transform: 'ToUpper', targetProperty: 'name' },
          { sourceField: 'Code', transform: 'SubString', transformArgs: { start: '1', end: '3' }, targetProperty: 'type' },
          { sourceField: 'Phone', transform: 'ReplaceStr', transformArgs: { old: '-', new: '' }, targetProperty: 'status' },
        ],
      },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateDtlClass(def, names);
    expect(src).toContain('..ToUpper(source.Name)');
    expect(src).toContain('..SubString(source.Code, 1, 3)');
    expect(src).toContain('..ReplaceStr(source.Phone, "-", "")');
  });
});

describe('generateBplClass', () => {
  it('is one code block: upsert via keyIndexOpen + DTL classmethod + %Save; no <call>, no context, no Storage', () => {
    const def = fileDef();
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBplClass(def, names);
    expect(src).toContain('Extends Ens.BusinessProcessBPL [ ClassType = persistent ]');
    expect(src).toContain('##class(SC.Data.Customer).uidIndexOpen(request.ID)');
    expect(src).toContain(`##class(${names.dtlClass}).Transform(request, .tTarget)`);
    expect(src).toContain('tTarget.%Save()');
    // The recurring failures must never regress:
    expect(src).not.toMatch(/<call\b/);
    expect(src).not.toMatch(/context\./);
    expect(src).not.toMatch(/Storage/);
    expect(src).not.toMatch(/Quit\s+tSC/); // no Quit-with-arg inside <code>
  });

  it('falls back to insert-only (%New only) when no key index', () => {
    const def = fileDef({ keyIndex: undefined, keyRequestProp: undefined });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBplClass(def, names);
    expect(src).toContain('Set tTarget = ##class(SC.Data.Customer).%New()');
    expect(src).not.toMatch(/IndexOpen/);
  });

  it('plain catchall (no FK-specific logging) when the target has no foreign keys', () => {
    const def = fileDef(); // no foreignKeys
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBplClass(def, names);
    expect(src).toContain('"Skipped request - "_$System.Status.GetErrorText(..%Context.%LastError)');
    expect(src).not.toContain('5829');
  });

  it('FK-aware catchall names the missing reference + value on a #5829', () => {
    const def = fileDef({
      process: {
        hasHeader: true,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'ID', targetProperty: 'uid' },
          { sourceField: 'Loc', targetProperty: 'primaryLocationId' },
        ],
      },
      foreignKeys: [
        { name: 'primaryLocationIdFK', referencedClass: 'SC.Data.Location', sourceFields: ['Loc'] },
      ],
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBplClass(def, names);
    // Branches on the FK error code, names the referenced class + the source value.
    expect(src).toContain('If tErrText [ "5829"');
    expect(src).toContain('FK constraint failed (SC.Data.Location)');
    expect(src).toContain('request.Loc');
    // Still logs the plain message for non-FK errors.
    expect(src).toContain('Else {');
    // Must NOT contain the bracket/quote form that broke OS paren-matching (#1010).
    expect(src).not.toContain("'\"]");
    expect(src).not.toMatch(/\["_/);
  });
});

describe('generateBusinessServiceClass', () => {
  it('File: EnsLib.File.InboundAdapter, header-lookup CSV parse, no %CSV.Reader/INVOCATION/Property Adapter', () => {
    const def = fileDef();
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBusinessServiceClass(def, names)!;
    expect(src).toContain('Parameter ADAPTER = "EnsLib.File.InboundAdapter";');
    expect(src).toContain('Set ..Adapter.FilePath = "/tmp/sco-workbench/csv"');
    expect(src).toContain('Set ..Adapter.FileSpec = "abc_customers.csv"');
    // Non-destructive ingest: never delete the source file (default is 1 = delete).
    expect(src).toContain('Set ..Adapter.DeleteFromServer = 0');
    expect(src).toContain('pInput.ReadLine()');
    expect(src).toContain('$ZStrip');
    expect(src).toContain('tHeaderMap');
    expect(src).toContain(`..SendRequestSync("${names.bpConfigName}", tRequest, .tResponse)`);
    // Never the invented forms:
    expect(src).not.toMatch(/%CSV\.Reader/);
    expect(src).not.toMatch(/Parameter INVOCATION/);
    expect(src).not.toMatch(/Property Adapter/);
    expect(src).not.toMatch(/\$ListFromString/);
    expect(src).not.toMatch(/Storage/);
  });

  it('no-header File: reads columns by 1-based position, no header map', () => {
    const def = fileDef({
      process: {
        hasHeader: false,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'ID', targetProperty: 'uid' },
          { sourceField: 'Name', targetProperty: 'name' },
        ],
      },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBusinessServiceClass(def, names)!;
    expect(src).toContain('Set tRequest.ID = $ZStrip($Piece(tLine, ",", 1), "<>WC")');
    expect(src).toContain('Set tRequest.Name = $ZStrip($Piece(tLine, ",", 2), "<>WC")');
    expect(src).not.toMatch(/tHeaderMap/);
  });

  it('SFTP: Protocol first, FTPServer/FilePath/Credentials, EnsLib.FTP.InboundAdapter', () => {
    const def = fileDef({
      adapter: 'SFTP',
      service: { host: 'sftp.example.com', port: 22, path: '/in', credentials: 'MyCreds', fileSpec: '*.csv' },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBusinessServiceClass(def, names)!;
    expect(src).toContain('Parameter ADAPTER = "EnsLib.FTP.InboundAdapter";');
    const protoIdx = src.indexOf('Set ..Adapter.Protocol = "SFTP"');
    const serverIdx = src.indexOf('Set ..Adapter.FTPServer');
    expect(protoIdx).toBeGreaterThan(-1);
    expect(protoIdx).toBeLessThan(serverIdx); // Protocol must be set first
    expect(src).toContain('Set ..Adapter.Credentials = "MyCreds"');
    // SFTP inherits DeleteFromServer=1 and would silently delete the remote file;
    // the generated service must turn it off so ingest is non-destructive.
    expect(src).toContain('Set ..Adapter.DeleteFromServer = 0');
    // ConfirmComplete=Size re-queries the size each poll and, when it can't, never
    // marks the file done → re-processes every poll. Turn it off.
    expect(src).toContain('Set ..Adapter.ConfirmComplete = 0');
    // We must NOT rename the source: the requirement is to leave the file exactly
    // as-is. Rename mutates the original name and often fails on SFTP anyway (no
    // rename permission → a Warning every poll); the done-table alone dedups
    // (verified live: "Skipping previously processed file" even after a failed rename).
    expect(src).not.toMatch(/Set \.\.Adapter\.RenameFilename/);
    // MLSD is an FTP command; SFTP lists via getFileInfo, so it must NOT be set here.
    expect(src).not.toMatch(/Set \.\.Adapter\.MLSD/);
  });

  it('FTP: DeleteFromServer=0 + ConfirmComplete=0, no MLSD, no rename (non-destructive, no re-processing)', () => {
    const def = fileDef({
      adapter: 'FTP',
      service: { host: 'ftp.example.com', port: 21, path: '/in', credentials: 'MyCreds', fileSpec: '*.csv' },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBusinessServiceClass(def, names)!;
    expect(src).toContain('Parameter ADAPTER = "EnsLib.FTP.InboundAdapter";');
    // Without this, the first poll RETRs then DELEs the file and the next poll logs
    // <Ens>ErrFTPListFailed (550 "No such file") re-listing the now-missing name.
    expect(src).toContain('Set ..Adapter.DeleteFromServer = 0');
    // ConfirmComplete=Size re-issues a LIST (getSize) that stock servers answer with
    // "226 Transfer complete" → ErrFTPGetSizeFailed AND the file is re-processed
    // every poll. Turn it off.
    expect(src).toContain('Set ..Adapter.ConfirmComplete = 0');
    // MLSD must stay at the IRIS default of 0. Verified live against vsftpd 3.0.2:
    // setting it hard-fails OnInit on any server whose FEAT reply has no MLST
    // ("ERROR #5001: MLSD set but not supported by FTP server"), and it also switches
    // FileSpec from wildcard to regex, so this very `*.csv` becomes an invalid pattern
    // (<Ens>ErrFTPRegex, "#8311: Syntax error in regexp pattern"). Covered end to end
    // by test/live-source/ftp.live.test.ts.
    expect(src).not.toMatch(/Set \.\.Adapter\.MLSD/);
    // We must NOT rename the source: the requirement is to leave the file exactly
    // as-is. DeleteFromServer=0 + ConfirmComplete=0 is the once-only guard; the
    // idempotent BPL upsert covers any rare re-read.
    expect(src).not.toMatch(/Set \.\.Adapter\.RenameFilename/);
  });

  it('Cloud: EnsLib.AmazonS3.InboundAdapter, reads from pInput.Content', () => {
    const def = fileDef({
      adapter: 'Cloud',
      service: { bucket: 'my-bucket', region: 'us-east-1', blobPattern: '*.csv' },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBusinessServiceClass(def, names)!;
    expect(src).toContain('Parameter ADAPTER = "EnsLib.AmazonS3.InboundAdapter";');
    expect(src).toContain('Set ..Adapter.BucketName = "my-bucket"');
    expect(src).toContain('Set tContent = pInput.Content');
  });

  it('Cloud: emits BlobNamePrefix (folder) and a FULL-KEY BlobNamePattern for one nested file', () => {
    // The adapter matches BlobNamePattern against the full blob key, so a nested
    // object's pattern is the whole relative key ("Test/locations.csv"), not the
    // leaf — the frontend builds it that way and the generator emits it verbatim.
    const def = fileDef({
      adapter: 'Cloud',
      service: {
        bucket: 'isc-sc-test-s3-4', region: 'us-east-1',
        credentialsFile: '/tmp/keys/abc_AWSCredentials',
        blobPrefix: 'Test/', blobPattern: 'Test/locations.csv',
      },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const src = generateBusinessServiceClass(def, names)!;
    expect(src).toContain('Set ..Adapter.BlobNamePrefix = "Test/"');
    expect(src).toContain('Set ..Adapter.BlobNamePattern = "Test/locations.csv"');
    expect(src).toContain('Set ..Adapter.ProviderCredentialsFile = "/tmp/keys/abc_AWSCredentials"');
    expect(src).toContain('Set ..Adapter.DeleteAfterDownload = 0');
  });

  it('SQL: no Business Service class is generated', () => {
    const def = fileDef({ adapter: 'SQL', service: { dsn: 'jdbc:IRIS://h:1972/SC', query: 'SELECT a FROM t', credentials: 'C' } });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    expect(generateBusinessServiceClass(def, names)).toBeNull();
  });
});

describe('generateConfigItems', () => {
  it('file-family: [BP, BS] both with NO settings (compiled into OnInit)', () => {
    const items = generateConfigItems(fileDef());
    expect(items.map((i) => i.className)).toEqual([
      'SC.Workbench.Integrationjob123.BP.test3Process',
      'SC.Workbench.Integrationjob123.BS.test3Service',
    ]);
    // BP first (enabled first), BS last.
    expect(items[0]!.note).toMatch(/Business Process/);
    expect(items[1]!.note).toMatch(/Business Service/);
    expect(items[0]!.settings).toEqual([]);
    expect(items[1]!.settings).toEqual([]);
  });

  it('SQL: [BP, JavaGateway(reuse), GenericService(full settings incl TargetConfigNames)]', () => {
    const def = fileDef({
      adapter: 'SQL',
      service: { dsn: 'jdbc:IRIS://h:1972/SC', query: 'SELECT uid, name FROM t', credentials: 'MyCred', keyField: 'uid' },
      keyRequestProp: 'uid',
      keyIndex: 'uidIndex',
      process: {
        hasHeader: true,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'uid', targetProperty: 'uid' },
          { sourceField: 'name', targetProperty: 'name' },
        ],
      },
    });
    const items = generateConfigItems(def);
    expect(items).toHaveLength(3);
    const [bp, gw, gs] = items;
    expect(bp!.className).toMatch(/\.BP\./);
    expect(gw!.className).toBe('EnsLib.JavaGateway.Service');
    expect(gw!.name).toBe('JavaGateway');
    expect(gw!.reuseIfExists).toBe(true);
    expect(gs!.className).toBe('EnsLib.SQL.Service.GenericService');
    const settingNames = gs!.settings.map((s) => `${s.name}:${s.target}`);
    expect(settingNames).toContain('DSN:Adapter');
    expect(settingNames).toContain('Query:Adapter');
    expect(settingNames).toContain('Credentials:Adapter');
    expect(settingNames).toContain('JGService:Adapter');
    expect(settingNames).toContain('JDBCDriver:Adapter');
    expect(settingNames).toContain('MessageClass:Host');
    expect(settingNames).toContain('TargetConfigNames:Host');
    // KeyFieldName is ALWAYS set explicitly — never left to default to "ID".
    expect(settingNames).toContain('KeyFieldName:Adapter');
    // No driverClass in the payload → JDBCDriver defaults to IRIS, and no
    // JDBCClasspath is set (the IRIS driver is on the gateway's default classpath).
    expect(gs!.settings.find((s) => s.name === 'JDBCDriver')!.value).toBe('com.intersystems.jdbc.IRISDriver');
    expect(settingNames).not.toContain('JDBCClasspath:Adapter');
  });

  it('SQL PostgreSQL: JDBCDriver from service.driverClass + JDBCClasspath from service.driverClasspath', () => {
    const def = fileDef({
      adapter: 'SQL',
      service: {
        dsn: 'jdbc:postgresql://h:5432/db',
        query: 'SELECT uid, name FROM t',
        credentials: 'MyCred',
        keyField: 'uid',
        driverClass: 'org.postgresql.Driver',
        driverClasspath: '/tmp/sco-workbench/drivers/postgresql-42.7.13.jar',
      },
      process: {
        hasHeader: true,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'uid', targetProperty: 'uid' },
          { sourceField: 'name', targetProperty: 'name' },
        ],
      },
    });
    const gs = generateConfigItems(def)[2]!;
    // Driver follows the source DB — NOT hardcoded to IRIS.
    expect(gs.settings.find((s) => s.name === 'JDBCDriver')!.value).toBe('org.postgresql.Driver');
    // The staged JAR path is set so the Java Gateway can load the non-IRIS driver.
    const cp = gs.settings.find((s) => s.name === 'JDBCClasspath');
    expect(cp, 'JDBCClasspath must be set for a non-IRIS source').toBeDefined();
    expect(cp!.target).toBe('Adapter');
    expect(cp!.value).toBe('/tmp/sco-workbench/drivers/postgresql-42.7.13.jar');
  });

  it('SQL KeyFieldName: uses the SOURCE key column (service.keyField) when the query selects it', () => {
    const def = fileDef({
      adapter: 'SQL',
      // Source key is uid; the query selects it (buildSqlQuery adds it). It need NOT
      // be mapped to a target property — the target auto-generates its own key.
      service: { dsn: 'd', query: 'SELECT name, uid FROM SC_Data.Customer', credentials: 'c', keyField: 'uid' },
      process: { hasHeader: true, targetClass: 'SC.Data.Customer', mappings: [{ sourceField: 'name', targetProperty: 'name' }] },
    });
    const gs = generateConfigItems(def)[2]!;
    expect(gs.settings.find((s) => s.name === 'KeyFieldName')!.value).toBe('uid');
  });

  it('SQL KeyFieldName: BLANK when the source has no detected key (the reported bug)', () => {
    // User removed the ID field; source has no key column → KeyFieldName must be
    // "" (disable tracking), NOT the "ID" default that fails every poll.
    const def = fileDef({
      adapter: 'SQL',
      service: { dsn: 'd', query: 'SELECT name, status FROM SC_Data.Customer', credentials: 'c' /* no keyField */ },
      process: {
        hasHeader: true,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'name', targetProperty: 'name' },
          { sourceField: 'status', targetProperty: 'status' },
        ],
      },
    });
    const gs = generateConfigItems(def)[2]!;
    expect(gs.settings.find((s) => s.name === 'KeyFieldName')!.value).toBe('');
  });

  it('SQL KeyFieldName: BLANK when a source key is set but the query omits that column', () => {
    // keyField says uid, but the query doesn't select uid → cannot track by a
    // column that isn't in the result set, so disable tracking (blank).
    const def = fileDef({
      adapter: 'SQL',
      service: { dsn: 'd', query: 'SELECT name FROM t', credentials: 'c', keyField: 'uid' },
      process: { hasHeader: true, targetClass: 'SC.Data.Customer', mappings: [{ sourceField: 'name', targetProperty: 'name' }] },
    });
    const gs = generateConfigItems(def)[2]!;
    expect(gs.settings.find((s) => s.name === 'KeyFieldName')!.value).toBe('');
  });

  it('SQL KeyFieldName: SELECT * is treated as selecting the source key column', () => {
    const def = fileDef({
      adapter: 'SQL',
      service: { dsn: 'd', query: 'SELECT * FROM t', credentials: 'c', keyField: 'uid' },
      process: { hasHeader: true, targetClass: 'SC.Data.Customer', mappings: [{ sourceField: 'name', targetProperty: 'name' }] },
    });
    const gs = generateConfigItems(def)[2]!;
    expect(gs.settings.find((s) => s.name === 'KeyFieldName')!.value).toBe('uid');
  });

  it('SQL: request message gets an extra property for an UNMAPPED source key column', () => {
    // The source key (uid) isn't mapped to a target property, but the typed message
    // must carry it so the polled KeyFieldName column has a home.
    const def = fileDef({
      adapter: 'SQL',
      name: 'SqlKeyFlow',
      service: { dsn: 'd', query: 'SELECT name, uid FROM t', credentials: 'c', keyField: 'uid' },
      process: { hasHeader: true, targetClass: 'SC.Data.Customer', mappings: [{ sourceField: 'name', targetProperty: 'name' }] },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const msg = generateMessageClass(def, names);
    expect(msg).toContain('Property name As %String;');
    expect(msg).toContain('Property uid As %String;'); // tracking-only key property
    // But the DTL does NOT assign the unmapped key onto the target.
    const dtl = generateDtlClass(def, names);
    expect(dtl).not.toContain("property='target.uid'");
  });

  it('SQL: no extra message property when the source key is already a mapped field', () => {
    const def = fileDef({
      adapter: 'SQL',
      service: { dsn: 'd', query: 'SELECT uid, name FROM t', credentials: 'c', keyField: 'uid' },
      process: {
        hasHeader: true,
        targetClass: 'SC.Data.Customer',
        mappings: [
          { sourceField: 'uid', targetProperty: 'uid' },
          { sourceField: 'name', targetProperty: 'name' },
        ],
      },
    });
    const names = integrationClassNames(def.id, sanitizeIntegrationName(def.name));
    const msg = generateMessageClass(def, names);
    // uid appears exactly once (from the mapping), not duplicated as a tracking prop.
    expect(msg.match(/Property uid As/g)).toHaveLength(1);
  });
});

describe('generateIntegrationClasses', () => {
  it('returns classes in compile order, SQL BS source null', () => {
    const roles = generateIntegrationClasses(fileDef()).map((c) => c.role);
    expect(roles).toEqual(['message', 'dtl', 'bpl', 'businessService']);

    const sql = generateIntegrationClasses(fileDef({ adapter: 'SQL', service: { dsn: 'd', query: 'q', credentials: 'c' } }));
    expect(sql.find((c) => c.role === 'businessService')!.source).toBeNull();
    // The other three are still generated for SQL.
    expect(sql.find((c) => c.role === 'message')!.source).toContain('Extends Ens.Request');
  });
});

describe('validateIntegrationDefinition', () => {
  it('accepts a well-formed File definition', () => {
    expect(validateIntegrationDefinition(fileDef())).toEqual([]);
  });

  it('rejects a non-fully-qualified target class', () => {
    const problems = validateIntegrationDefinition(fileDef({ process: { ...fileDef().process, targetClass: 'Customer' } }));
    expect(problems.join(' ')).toMatch(/fully-qualified/);
  });

  it('rejects an illegal source field (not an identifier)', () => {
    const problems = validateIntegrationDefinition(
      fileDef({ process: { ...fileDef().process, mappings: [{ sourceField: 'first name', targetProperty: 'name' }] } }),
    );
    expect(problems.join(' ')).toMatch(/not a legal property name/);
  });

  it('rejects a keyRequestProp that is not a mapped field', () => {
    const problems = validateIntegrationDefinition(fileDef({ keyRequestProp: 'NotMapped' }));
    expect(problems.join(' ')).toMatch(/keyRequestProp/);
  });

  it('requires filePath/fileSpec for File and host/path for FTP', () => {
    expect(validateIntegrationDefinition(fileDef({ service: {} })).join(' ')).toMatch(/filePath/);
    expect(
      validateIntegrationDefinition(fileDef({ adapter: 'FTP', service: {} })).join(' '),
    ).toMatch(/host/);
  });
});
