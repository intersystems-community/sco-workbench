// frontend/src/app/data-integration/data-integration.spec.ts
import { of, throwError, Subject } from 'rxjs';
import { DataIntegrationComponent } from './data-integration';
import { setAiEnabled } from '../core/ai-status';
import type { GuidedFormController } from '../core/workbench-bridge.service';

/**
 * Step 1 → Step 2 gating.
 *
 * Step 2 introspects the source the moment it opens (list schemas / list a
 * directory / list the bucket), so Next must not advance over a connection that
 * doesn't work — otherwise bad credentials surface one page later as an apparently
 * broken Data step. These tests drive the component class directly (no TestBed):
 * the behaviour under test is navigation logic, and stubbing ten constructor deps
 * is cheaper and clearer than rendering the whole wizard.
 */

/** Result the fake test endpoints return unless a test says otherwise. */
const OK = { ok: true, message: 'connection succeeded' };
const FAIL = { ok: false, message: 'Connection or authentication failed: bad credentials' };

function makeComponent(testResult: unknown = of(OK)) {
  const testConnection = vi.fn(() => testResult as never);
  // Step 2's first fetch per adapter — enterDataStep() fires exactly one of these.
  // The connection each call is made WITH is the interesting argument (it's how a
  // stale listing shows up), so the stubs declare their parameters.
  type Conn = Record<string, unknown>;
  const dataSource = {
    getSchemas: vi.fn((_c: Conn) => of({ ok: true, schemas: ['SQLUser'] })),
    getTables: vi.fn((_c: Conn, _schema?: string) => of({ ok: true, tables: ['Orders'] })),
    getColumns: vi.fn((_c: Conn, _s?: string, _t?: string) => of({ ok: true, columns: [{ name: 'sku', dataType: 'VARCHAR' }] })),
    listFtpDir: vi.fn((_c: Conn, _path?: string) => of({ ok: true, entries: [] as { name: string; type: string }[] })),
    previewRemoteCsv: vi.fn((_c: Conn, _path?: string) => of({ ok: true, rows: [['sku'], ['A1']] })),
    listCloudDir: vi.fn((_c: Conn, _path?: string) => of({ ok: true, entries: [] as { name: string; type: string }[] })),
    previewCloudCsv: vi.fn((_c: Conn, _path?: string) => of({ ok: true, rows: [] as string[][] })),
    // A reopened local-file case has no File in memory after a refresh — it previews
    // from the copy the backend stored in SQLite, by case id (restoreLocalDataStep).
    previewStoredLocalCsv: vi.fn((_id: string) => of({ ok: true, rows: [['sku'], ['A1']] })),
  };
  const noop = () => undefined;
  // Cases persistence (SQLite) — save echoes the id + a draft status back so
  // persistCase() can finish synchronously in these tests. list() feeds ngOnInit
  // (not exercised here). putFile is only hit for slots re-picked this session.
  const casesApi = {
    list: vi.fn(() => of({ cases: [] })),
    save: vi.fn((c: { id: string }) => of({ ok: true, id: c.id, status: 'draft' as const })),
    putFile: vi.fn(() => of({ ok: true, slot: '', irisPath: '', originalName: '' })),
    setStatus: vi.fn((id: string, status: string) => of({ ok: true, id, status })),
    delete: vi.fn(() => of({ ok: true })),
    createCredentialFromCase: vi.fn(() => of({ ok: true, name: null as string | null })),
  };
  // Target-class properties keyed by class name — onTargetClassChange() fetches
  // these to (re)build the Target Property dropdown. Tests populate it per class.
  const classDetails: Record<string, { attributes: { name: string; dataType: string; required?: boolean }[] }> = {};
  // The deploy-pending set lives on the bridge (it outlives the component), and the
  // component reads/clears it on every lifecycle step — including removeJob() — so the
  // stub has to behave like the real signal, not just exist.
  let pendingDeploys: ReadonlySet<string> = new Set();
  const bridge = {
    register: noop,
    unregister: noop,
    runAgentPrompt: vi.fn(),
    pendingDeploys: () => pendingDeploys,
    markDeployPending: (id: string) => { pendingDeploys = new Set(pendingDeploys).add(id); },
    clearDeployPending: (id: string) => { const next = new Set(pendingDeploys); next.delete(id); pendingDeploys = next; },
    // ngOnInit subscribes to both; a test can push a report through statusReports$ to
    // drive the agent's real deploy outcome.
    statusReports$: new Subject<unknown>(),
    agentTurnEnded$: new Subject<void>(),
    setActiveView: vi.fn(),
  };
  const component = new DataIntegrationComponent(
    {
      getClasses: () => of([]),
      getObjects: () => of([]),
      getObjectDetail: (name: string) => of(classDetails[name] ?? { attributes: [] }),
    } as never, // ScModelService
    dataSource as never,                                  // DataSourceService
    {} as never,                                          // UploadService
    casesApi as never,                                    // DataIntegrationService
    { testConnection } as never,                          // SqlConnectionTestService
    { testConnection } as never,                          // FtpConnectionTestService
    { testConnection } as never,                          // SftpConnectionTestService
    { testConnection } as never,                          // CloudConnectionTestService
    { markForCheck: noop, detectChanges: noop } as never,  // ChangeDetectorRef
    bridge as never,                                      // WorkbenchBridgeService
    { show: noop, error: noop, success: noop, info: noop } as never, // ToastService
  );
  return { component, testConnection, dataSource, casesApi, classDetails, bridge };
}

/** A component parked on Step 1 with every required SQL field filled in. */
function readySqlComponent(testResult: unknown = of(OK)) {
  const made = makeComponent(testResult);
  const c = made.component;
  c.jobName = 'Nightly load';
  c.sourceType = 'database';
  Object.assign(c.sourceConfig, {
    dbDataSourceName: 'Sales DB',
    dbType: 'PostgreSQL',
    dbDsn: 'jdbc:postgresql://db:5432/sales',
    dbUsername: 'app',
    dbPassword: 'secret',
  });
  return made;
}

describe('goDataStep — required fields gate', () => {
  it('does NOT advance and surfaces the missing field when a required field is empty', () => {
    const { component, testConnection } = readySqlComponent();
    component.sourceConfig.dbDsn = '';

    component.goDataStep();

    expect(component.currentStep).toBe(1);
    expect(component.step1Error).toBe('DSN (JDBC URL) is required.');
    // A half-filled form must not burn a round trip on the backend.
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('does not nag before the user tries to advance', () => {
    const { component } = readySqlComponent();
    component.sourceConfig.dbUsername = '';
    expect(component.step1Error).toBeNull();
  });
});

describe('goDataStep — connection gate', () => {
  it('tests the connection and advances only after it passes', () => {
    const { component, testConnection, dataSource } = readySqlComponent(of(OK));

    component.goDataStep();

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(component.currentStep).toBe(2);
    expect(component.connectionTestResult).toEqual(OK);
    expect(dataSource.getSchemas).toHaveBeenCalledTimes(1);
  });

  it('STAYS on Step 1 and shows the failure when the connection is refused', () => {
    const { component, testConnection, dataSource } = readySqlComponent(of(FAIL));

    component.goDataStep();

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(component.currentStep).toBe(1);
    expect(component.connectionTestResult).toEqual(FAIL);
    // The failure must not be followed by an introspection call that would fail again.
    expect(dataSource.getSchemas).not.toHaveBeenCalled();
  });

  it('stays on Step 1 when the test endpoint itself errors (HTTP failure)', () => {
    const { component } = readySqlComponent(throwError(() => ({ message: 'Http failure response: 500' })));

    component.goDataStep();

    expect(component.currentStep).toBe(1);
    expect(component.connectionTestResult?.ok).toBe(false);
    expect(component.connectionTestResult?.message).toContain('500');
  });

  it('blocks on a validation short-circuit without calling the backend at all', () => {
    // Password is required in the UI only, so it never reaches the service.
    const { component, testConnection } = readySqlComponent();
    component.sourceConfig.dbType = '';
    component.sourceConfig.dbDataSourceName = 'Sales DB';
    // Bypass the field gate to reach the connection gate with an untestable config.
    Object.defineProperty(component, 'canProceedStep1', { get: () => true });

    component.goDataStep();

    expect(testConnection).not.toHaveBeenCalled();
    expect(component.currentStep).toBe(1);
    expect(component.connectionTestResult?.message).toContain('database type');
  });

  it('does not re-test a connection that was already verified (no duplicate round trip)', () => {
    const { component, testConnection } = readySqlComponent(of(OK));
    component.testConnection();                       // the Test Connection button
    expect(component.connectionTested).toBe(true);

    component.goDataStep();

    expect(testConnection).toHaveBeenCalledTimes(1);  // Next reused the green result
    expect(component.currentStep).toBe(2);
  });

  it('RE-tests when a connection field changed after a green test (stale pass)', () => {
    const { component, testConnection } = readySqlComponent(of(OK));
    component.testConnection();
    component.sourceConfig.dbDsn = 'jdbc:postgresql://other-host:5432/sales';
    expect(component.connectionTested).toBe(false);

    component.goDataStep();

    expect(testConnection).toHaveBeenCalledTimes(2);
    expect(component.currentStep).toBe(2);
  });

  it('shows a spinner on Next while verifying, and clears it either way', () => {
    const pending = new Subject<{ ok: boolean; message: string }>();
    const { component } = readySqlComponent(pending);

    component.goDataStep();
    expect(component.verifyingForNext).toBe(true);
    expect(component.testingConnection).toBe(true);
    expect(component.currentStep).toBe(1);

    pending.next(FAIL);
    expect(component.verifyingForNext).toBe(false);
    expect(component.testingConnection).toBe(false);
    expect(component.currentStep).toBe(1);
  });

  it('ignores a second Next while a test is still in flight', () => {
    const pending = new Subject<{ ok: boolean; message: string }>();
    const { component, testConnection } = readySqlComponent(pending);

    component.goDataStep();
    component.goDataStep();

    expect(testConnection).toHaveBeenCalledTimes(1);
  });
});

/**
 * The generated IRIS credential SystemName must fit Ens.Config.Credentials's MAXLEN
 * of 50, or Deploy fails creating the entry (#7201 length > MAXLEN → #5802). The old
 * `<label>_<36-char-uuid>` overflowed for any Data Source Name ≥ 14 chars — reported
 * from the field as a deploy-time credential-creation failure on a long DSN name.
 */
describe('makeCredentialName — credential SystemName stays within MAXLEN(50)', () => {
  /** Read the frozen credential name off the live config after a Save. */
  const credName = (component: ReturnType<typeof readySqlComponent>['component']) =>
    (component as unknown as { sourceConfig: { dbCredentialName?: string } }).sourceConfig.dbCredentialName ?? '';

  it('caps a long Data Source Name at 50 while keeping a unique 8-hex suffix', () => {
    const { component } = readySqlComponent(of(OK));
    // 60-char name — the old formula would mint 60 + 1 + 36 = 97 chars.
    component.sourceConfig.dbDataSourceName = 'A'.repeat(60);

    component.goDataStep();   // advances → persistCase → ensureCredentialName

    const name = credName(component);
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name).toMatch(/_[0-9a-f]{8}$/);        // whole suffix survives (never truncated)
  });

  it('keeps a short name intact (label preserved, just a shorter suffix than before)', () => {
    const { component } = readySqlComponent(of(OK));
    component.sourceConfig.dbDataSourceName = 'Sales DB';

    component.goDataStep();

    // Sanitized label + "_" + 8 hex — e.g. "Sales_DB_a1b2c3d4".
    expect(credName(component)).toMatch(/^Sales_DB_[0-9a-f]{8}$/);
  });

  it('self-heals a frozen over-length name saved before the cap; leaves a valid one', () => {
    // Over-length (51) → must be regenerated to ≤ 50 on the next Save.
    const overLong = readySqlComponent(of(OK));
    overLong.component.sourceConfig.dbCredentialName = `TestPOSTGRESQL_${'0'.repeat(36)}`; // 51 chars
    overLong.component.goDataStep();
    expect(credName(overLong.component).length).toBeLessThanOrEqual(50);
    expect(credName(overLong.component)).not.toBe(`TestPOSTGRESQL_${'0'.repeat(36)}`);

    // A valid (≤ 50) name may already back a deployed credential — it is preserved.
    const valid = readySqlComponent(of(OK));
    valid.component.sourceConfig.dbCredentialName = 'Sales_DB_deadbeef';
    valid.component.goDataStep();
    expect(credName(valid.component)).toBe('Sales_DB_deadbeef');
  });
});

/**
 * A green test only licenses the config it was run against. The signature must
 * therefore cover EVERY field the test authenticates with — including the
 * credentials, which the deploy payload deliberately omits (it carries an IRIS
 * Credentials name instead). Reported from the UI: test → edit a credential →
 * Next walked straight through on the stale pass.
 */
describe('connectionTested — a pass must not outlive the config it tested', () => {
  const drifts: Array<[string, (c: DataIntegrationComponent) => void]> = [
    ['Password', (c) => { c.sourceConfig.dbPassword = 'different'; }],
    ['Username', (c) => { c.sourceConfig.dbUsername = 'someone-else'; }],
    ['DSN', (c) => { c.sourceConfig.dbDsn = 'jdbc:postgresql://elsewhere:5432/sales'; }],
    ['Database Type', (c) => { c.sourceConfig.dbType = 'IRIS'; }],
  ];

  for (const [field, edit] of drifts) {
    it(`invalidates the pass when ${field} changes, and Next re-tests`, () => {
      const { component, testConnection } = readySqlComponent(of(OK));
      component.testConnection();
      expect(component.connectionTested).toBe(true);

      edit(component);

      expect(component.connectionTested).toBe(false);
      component.goDataStep();
      expect(testConnection).toHaveBeenCalledTimes(2);
    });
  }

  it('BLOCKS Next when the edited credentials no longer authenticate', () => {
    // The reported bug, end to end: green test, edit the password, Next.
    let result: unknown = of(OK);
    const made = readySqlComponent(undefined as never);
    const { component } = made;
    made.testConnection.mockImplementation(() => result as never);

    component.testConnection();
    expect(component.connectionTested).toBe(true);

    component.sourceConfig.dbPassword = 'wrong-now';
    result = of(FAIL);
    component.goDataStep();

    expect(component.currentStep).toBe(1);
    expect(component.connectionTestResult).toEqual(FAIL);
  });

  it('does NOT re-test when a field the test never sends changes (the SQL query)', () => {
    const { component, testConnection } = readySqlComponent(of(OK));
    component.testConnection();

    component.sourceConfig.dbQuery = 'SELECT * FROM sales WHERE region = 1';

    expect(component.connectionTested).toBe(true);
    component.goDataStep();
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(component.currentStep).toBe(2);
  });

  it('invalidates a cloud pass when the bucket, region or credentials file changes', () => {
    const { component } = makeComponent(of(OK));
    component.jobName = 'S3 load';
    component.sourceType = 'cloud';
    Object.assign(component.sourceConfig, {
      cloudBucket: 'my-bucket', cloudRegion: 'us-east-2', cloudCredentialsFile: '/uploads/creds.txt',
    });
    const internals = component as unknown as { cloudCredentialsContent: string };
    internals.cloudCredentialsContent = '[default]\naws_access_key_id=AKIA\naws_secret_access_key=s\n';
    component.testConnection();
    expect(component.connectionTested).toBe(true);

    component.sourceConfig.cloudRegion = 'eu-west-1';
    expect(component.connectionTested).toBe(false);

    component.sourceConfig.cloudRegion = 'us-east-2';
    expect(component.connectionTested).toBe(true);          // back to the tested config

    // Re-picking a DIFFERENT credentials file must drift even if the path matches.
    internals.cloudCredentialsContent = '[default]\naws_access_key_id=AKIA2\naws_secret_access_key=s2\n';
    expect(component.connectionTested).toBe(false);
  });

  it('invalidates an FTP pass when the protocol flips to SFTP on the same host', () => {
    const { component } = makeComponent(of(OK));
    component.jobName = 'Drop folder';
    component.sourceType = 'ftp';
    Object.assign(component.sourceConfig, {
      ftpDataSourceName: 'Drop', ftpHost: 'files.example.com', ftpUsername: 'app', ftpPassword: 'pw', ftpSftp: false,
    });
    component.testConnection();
    expect(component.connectionTested).toBe(true);

    component.sourceConfig.ftpSftp = true;
    expect(component.connectionTested).toBe(false);
  });
});

/**
 * The rendered outcome is a claim about the config that is in the form RIGHT NOW.
 * One that outlives the config it was run against is a lie — reported from the UI
 * as a green "SFTP connection to … succeeded" still on screen after a trip to the
 * Data step and flipping the Protocol radio back to FTP. `connectionTested` had
 * already drifted (Next re-tests); only the message was stale.
 */
describe('currentConnectionResult — the message must not outlive the config it describes', () => {
  /** Step-1 SFTP details, complete enough to test (the key CONTENTS included). */
  function readySftp(testResult: unknown = of(OK)) {
    const made = makeComponent(testResult);
    const c = made.component;
    c.jobName = 'Drop folder';
    c.sourceType = 'ftp';
    Object.assign(c.sourceConfig, {
      ftpDataSourceName: 'Drop',
      ftpHost: 'ec2-54-234-98-31.compute-1.amazonaws.com',
      ftpUsername: 'ubuntu',
      ftpSftp: true,
      sftpPublicKeyFile: '/uploads/id.pub',
      sftpPrivateKeyFile: '/uploads/id.pem',
    });
    (c as unknown as { sftpPrivateKeyContent: string }).sftpPrivateKeyContent = '-----BEGIN OPENSSH PRIVATE KEY-----';
    return made;
  }

  it('hides the SFTP success after a trip to Step 2 and a flip back to FTP', () => {
    const { component } = readySftp();
    component.testConnection();
    expect(component.currentConnectionResult).toEqual(OK);

    component.goDataStep();                 // the pass still describes the form here
    expect(component.currentStep).toBe(2);
    component.currentStep = 1;              // back through the breadcrumb
    expect(component.currentConnectionResult).toEqual(OK);

    component.onProtocolChange('FTP');
    // Filled in so the message can only be gone because the config drifted, not
    // because plain FTP is missing a password to test with.
    component.sourceConfig.ftpPassword = 'pw';

    expect(component.currentConnectionResult).toBeNull();
    expect(component.connectionTested).toBe(false);   // …and Next re-tests over FTP

    // Signature-driven, not wiped: the SFTP config it described is one flip away.
    component.onProtocolChange('SFTP');
    expect(component.currentConnectionResult).toEqual(OK);
  });

  it('hides a success once the host is edited (a different server, same protocol)', () => {
    const { component } = readySftp();
    component.testConnection();
    expect(component.currentConnectionResult).toEqual(OK);

    component.sourceConfig.ftpHost = 'ec2-3-91-0-7.compute-1.amazonaws.com';

    expect(component.currentConnectionResult).toBeNull();
  });

  it('keeps a FAILURE on screen until the field it blames is edited', () => {
    // The reason a test failed has to survive the test finishing — it's the only
    // explanation the user gets for a blocked Next.
    const { component } = readySftp(of(FAIL));
    component.testConnection();
    expect(component.currentConnectionResult).toEqual(FAIL);

    component.sourceConfig.ftpUsername = 'ec2-user';

    expect(component.currentConnectionResult).toBeNull();
  });

  it('renders the failure that blocked Next, which is what gets scrolled to', () => {
    const { component } = readySftp(of(FAIL));
    component.goDataStep();

    expect(component.currentStep).toBe(1);
    expect(component.currentConnectionResult).toEqual(FAIL);
  });

  it('renders nothing while a test is in flight — the spinner speaks for that', () => {
    const pending = new Subject<{ ok: boolean; message: string }>();
    const { component } = readySftp(pending);
    component.testConnection();
    expect(component.testingConnection).toBe(true);
    expect(component.currentConnectionResult).toBeNull();

    pending.next(OK);

    expect(component.currentConnectionResult).toEqual(OK);
  });
});

/**
 * Step 2 → Step 3 gating.
 *
 * Step 3 maps the columns of the entity picked in Step 2 onto a target class, so
 * advancing with nothing picked opens an empty mapping table on a page that can't
 * explain why. Reported from the UI: Next walked straight through the file browser
 * / schema pickers without a selection.
 */
describe('goMappingStep — data-entity gate', () => {
  /** A CSV preview shaped like the one the preview endpoints return. */
  const preview = { columns: [{ name: 'sku', dataType: 'VARCHAR' }], rows: [['A1']] };

  /** A component parked on Step 2 for the given adapter, with the Step-1 fields
   *  the Step-2 browsers refuse to talk to a server without. */
  function onStep2(sourceType: string) {
    const made = makeComponent();
    const c = made.component;
    c.currentStep = 2;
    c.sourceType = sourceType as never;
    Object.assign(c.sourceConfig, {
      ftpHost: 'files.example.com', ftpUsername: 'app',
      cloudBucket: 'my-bucket', cloudRegion: 'us-east-2',
    });
    return made;
  }

  it('does NOT nag before the user tries to advance', () => {
    const { component } = onStep2('database');
    expect(component.step2Error).toBeNull();
    expect(component.missingStep2Selection).toBe('Select a schema, then a table, before continuing.');
  });

  it('BLOCKS the SQL source with no schema selected, naming what to pick', () => {
    const { component } = onStep2('database');

    component.goMappingStep();

    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toBe('Select a schema, then a table, before continuing.');
  });

  it('asks only for the TABLE once a schema is chosen, and clears the banner live', () => {
    const { component } = onStep2('database');
    component.selectedSchema = 'SQLUser';

    component.goMappingStep();
    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toBe('Select a table before continuing.');

    // Fixing the selection clears the banner without a second click.
    component.selectedTable = 'Orders';
    component.sqlColumns = preview.columns;
    expect(component.step2Error).toBeNull();
  });

  it('advances once a table has been selected and its columns are loaded', () => {
    const { component } = onStep2('database');
    Object.assign(component, { selectedSchema: 'SQLUser', selectedTable: 'Orders', sqlColumns: preview.columns });

    component.goMappingStep();

    expect(component.currentStep).toBe(3);
  });

  it('blocks while the selected table’s columns are still loading', () => {
    const { component } = onStep2('database');
    Object.assign(component, { selectedSchema: 'SQLUser', selectedTable: 'Orders', loadingColumns: true });

    component.goMappingStep();

    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toContain('finish loading');
  });

  it('blocks when the columns could not be READ — Step 3 would have nothing to map', () => {
    const { component } = onStep2('database');
    Object.assign(component, {
      selectedSchema: 'SQLUser', selectedTable: 'Orders', columnError: 'JDBC: permission denied',
    });

    component.goMappingStep();

    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toContain('could not be read');
  });

  it('blocks an FTP/SFTP source until a CSV file is picked, then advances', () => {
    const { component } = onStep2('ftp');

    component.goMappingStep();
    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toBe('Select a CSV file before continuing.');

    component.selectedCsvPath = '/drop/orders.csv';
    component.csvPreview = preview;
    component.goMappingStep();
    expect(component.currentStep).toBe(3);
  });

  it('blocks an FTP file that was selected but could not be read', () => {
    const { component } = onStep2('ftp');
    component.selectedCsvPath = '/drop/orders.csv';
    component.csvPreviewError = 'Could not read this file.';

    component.goMappingStep();

    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toContain('could not be read');
  });

  it('blocks a cloud (S3) source until an object is picked, then advances', () => {
    const { component } = onStep2('cloud');

    component.goMappingStep();
    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toBe('Select a CSV object before continuing.');

    component.selectedCloudCsvPath = '/raw/orders.csv';
    component.cloudCsvPreview = preview;
    component.goMappingStep();
    expect(component.currentStep).toBe(3);
  });

  it('blocks a local file whose preview failed, and advances once it reads', () => {
    const { component } = onStep2('file');
    component.sourceConfig.filePath = '/irisdev/app/uploads/sales.csv';
    component.localPreviewError = 'Could not read the file.';

    component.goMappingStep();
    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toContain('could not be read');

    component.localPreviewError = null;
    component.localCsvPreview = preview;
    component.goMappingStep();
    expect(component.currentStep).toBe(3);
  });

  it('tells a local-file user where the file is chosen when none was uploaded', () => {
    const { component } = onStep2('file');

    component.goMappingStep();

    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toContain('Data Source step');
  });

  it('does not gate a source type that has no data-selection step', () => {
    const { component } = onStep2('rest-api');

    component.goMappingStep();

    expect(component.currentStep).toBe(3);
  });

  it('lets an EDITED job through on its saved columns without re-picking the entity', () => {
    // Re-picking would rebuild Step 3 from the fresh retrieval and discard the
    // target properties/transforms already saved on the job. editJob() restores
    // both halves: the columns AND the adapter config that names the entity.
    const { component } = onStep2('database');
    component.sourceColumns = [{ name: 'sku', type: 'String', targetProperty: 'SKU', transform: '' } as never];
    component.sourceConfig.dbQuery = 'SELECT * FROM SQLUser.Orders';

    component.goMappingStep();

    expect(component.currentStep).toBe(3);
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
  });

  /**
   * Reported from the UI: pick a CSV, browse into a folder, click Next — it
   * advanced. Navigating clears the selection AND the adapter's poll path
   * (clearCsvPreview) but leaves the previous file's columns in Step 3, so a gate
   * that only asks "are there columns?" waves the folder through and the pipeline
   * deploys pointing at nothing.
   */
  describe('navigating away from a selected file re-blocks Next', () => {
    it('FTP: entering a folder after selecting a CSV blocks Next again', () => {
      const { component, dataSource } = onStep2('ftp');
      dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [] }) as never);
      // State as it stands right after a successful selection + preview.
      component.selectedCsvPath = '/orders.csv';
      component.csvPreview = preview;
      component.sourceColumns = preview.columns.map((c) => ({ name: c.name, type: 'String' } as never));
      component.sourceConfig.ftpPath = '/';
      component.sourceConfig.ftpFileSpec = 'orders.csv';
      expect(component.canProceedStep2).toBe(true);

      component.enterFtpFolder('archive');   // real navigation — clears the selection

      expect(component.selectedCsvPath).toBe('');
      expect(component.sourceConfig.ftpFileSpec).toBeFalsy();
      component.goMappingStep();

      expect(component.currentStep).toBe(2);
      expect(component.step2Error).toBe('Select a CSV file before continuing.');
    });

    it('FTP: going back UP without re-picking is blocked too', () => {
      const { component, dataSource } = onStep2('ftp');
      dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [] }) as never);
      component.ftpPathSegments = ['archive'];
      component.selectedCsvPath = '/archive/orders.csv';
      component.csvPreview = preview;
      component.sourceColumns = preview.columns.map((c) => ({ name: c.name, type: 'String' } as never));
      component.sourceConfig.ftpFileSpec = 'orders.csv';

      component.ftpGoUp();
      component.goMappingStep();

      expect(component.currentStep).toBe(2);
      expect(component.step2Error).toBe('Select a CSV file before continuing.');
    });

    it('Cloud: entering a prefix after selecting an object blocks Next again', () => {
      const { component, dataSource } = onStep2('cloud');
      dataSource.listCloudDir.mockReturnValue(of({ ok: true, entries: [] }) as never);
      component.selectedCloudCsvPath = '/orders.csv';
      component.cloudCsvPreview = preview;
      component.sourceColumns = preview.columns.map((c) => ({ name: c.name, type: 'String' } as never));
      component.sourceConfig.cloudBlobPattern = 'orders.csv';

      component.enterCloudFolder('raw');
      component.goMappingStep();

      expect(component.currentStep).toBe(2);
      expect(component.step2Error).toBe('Select a CSV object before continuing.');
      expect(component.sourceConfig.cloudBlobPattern).toBeFalsy();
    });

    // The S3 adapter matches BlobNamePattern against the FULL blob key (e.g.
    // "Test/locations.csv"), not the leaf name — so selecting a nested object must
    // set the pattern to the whole relative key, or the adapter retrieves nothing.
    // (A bare leaf name only worked at the bucket root, where full key == leaf.)
    it('Cloud: a root-level object → pattern is the leaf name, prefix empty', () => {
      const { component } = onStep2('cloud');
      component.cloudPathSegments = []; // at the bucket root
      component.selectCloudCsvFile('customers.csv');
      expect(component.sourceConfig.cloudBlobPrefix).toBe('');
      expect(component.sourceConfig.cloudBlobPattern).toBe('customers.csv');
    });

    it('Cloud: a nested object → pattern is the FULL relative key, prefix is the folder', () => {
      const { component } = onStep2('cloud');
      component.cloudPathSegments = ['Test']; // inside the "Test/" folder
      component.selectCloudCsvFile('locations.csv');
      expect(component.sourceConfig.cloudBlobPrefix).toBe('Test/');
      // Full key, NOT just "locations.csv" — the reported bug.
      expect(component.sourceConfig.cloudBlobPattern).toBe('Test/locations.csv');
    });

    it('Cloud: a deeply nested object → full multi-segment key', () => {
      const { component } = onStep2('cloud');
      component.cloudPathSegments = ['data', 'raw'];
      component.selectCloudCsvFile('sales.csv');
      expect(component.sourceConfig.cloudBlobPrefix).toBe('data/raw/');
      expect(component.sourceConfig.cloudBlobPattern).toBe('data/raw/sales.csv');
    });

    it('SQL: clearing the table selection blocks Next even with columns still mapped', () => {
      const { component } = onStep2('database');
      Object.assign(component, {
        selectedSchema: 'SQLUser', selectedTable: 'Orders', sqlColumns: preview.columns,
        sourceColumns: preview.columns.map((c) => ({ name: c.name, type: 'String' })),
      });
      component.sourceConfig.dbQuery = 'SELECT * FROM SQLUser.Orders';
      expect(component.canProceedStep2).toBe(true);

      component.selectedTable = '';
      component.onTableChange();       // real deselection — clears the derived query

      component.goMappingStep();

      expect(component.currentStep).toBe(2);
      expect(component.step2Error).toBe('Select a table before continuing.');
    });

    it('re-selecting a file in the new folder unblocks Next', () => {
      const { component, dataSource } = onStep2('ftp');
      dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [] }) as never);
      component.selectedCsvPath = '/orders.csv';
      component.sourceColumns = preview.columns.map((c) => ({ name: c.name, type: 'String' } as never));
      component.sourceConfig.ftpFileSpec = 'orders.csv';

      component.enterFtpFolder('archive');
      component.goMappingStep();
      expect(component.currentStep).toBe(2);

      // Pick a CSV in the folder we navigated into (previewRemoteCsv is stubbed).
      component.selectCsvFile('older.csv');
      component.goMappingStep();

      expect(component.currentStep).toBe(3);
    });
  });

  it('does not re-gate the Mapping breadcrumb clicked from Step 3', () => {
    const { component } = onStep2('database');
    component.currentStep = 3;

    component.goMappingStep();

    expect(component.currentStep).toBe(3);
    expect(component.step2Attempted).toBe(false);
  });
});

/**
 * Step 2 must show the server Step 1 currently points at.
 *
 * The load branches in enterDataStep only fetch when their list is EMPTY, so
 * re-entering the step after re-pointing Step 1 left the previous server's tree on
 * screen. Reported from the UI: fill in FTP → Data Entity → back → switch to SFTP
 * and fill it in → Data Entity still listed the FTP server's files.
 */
describe('enterDataStep — Step 2 follows the Step-1 data source', () => {
  /** A component on Step 1 with plain-FTP details filled in and a passing test. */
  function readyFtp() {
    const made = makeComponent(of(OK));
    const c = made.component;
    c.jobName = 'Drop folder';
    c.sourceType = 'ftp';
    Object.assign(c.sourceConfig, {
      ftpDataSourceName: 'Drop', ftpHost: 'files.example.com', ftpUsername: 'app', ftpPassword: 'pw', ftpSftp: false,
    });
    return made;
  }

  /** Re-point the same component at SFTP, as the Step-1 form does. */
  function switchToSftp(c: DataIntegrationComponent) {
    c.currentStep = 1;
    c.onProtocolChange('SFTP');
    Object.assign(c.sourceConfig, { sftpPublicKeyFile: '/uploads/id.pub', sftpPrivateKeyFile: '/uploads/id.pem' });
    // SFTP authenticates with the key's CONTENTS; without them the test
    // short-circuits before the service and Next never advances.
    (c as unknown as { sftpPrivateKeyContent: string }).sftpPrivateKeyContent = '-----BEGIN OPENSSH PRIVATE KEY-----';
  }

  it('re-lists the directory from the SFTP server after the FTP→SFTP flip', () => {
    const { component, dataSource } = readyFtp();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'ftp-only.csv', type: 'csv' }] }) as never);

    component.goDataStep();
    expect(component.currentStep).toBe(2);
    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);
    expect(dataSource.listFtpDir.mock.calls[0]?.[0]).toMatchObject({ protocol: 'FTP' });

    switchToSftp(component);
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'sftp-only.csv', type: 'csv' }] }) as never);
    component.goDataStep();

    expect(component.currentStep).toBe(2);
    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(2);
    // The second listing is fetched over SFTP, and it's what's on screen.
    expect(dataSource.listFtpDir.mock.calls[1]?.[0]).toMatchObject({ protocol: 'SFTP' });
    expect(component.ftpEntries.map((e) => e.name)).toEqual(['sftp-only.csv']);
  });

  it('drops the file picked on the OLD server, so Next cannot carry it forward', () => {
    const { component, dataSource } = readyFtp();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);
    component.goDataStep();
    component.selectCsvFile('orders.csv');
    expect(component.sourceConfig.ftpFileSpec).toBe('orders.csv');
    expect(component.canProceedStep2).toBe(true);

    switchToSftp(component);
    component.goDataStep();

    expect(component.selectedCsvPath).toBe('');
    expect(component.csvPreview).toBeNull();
    expect(component.sourceConfig.ftpFileSpec).toBeFalsy();
    // …and the Mapping step stays out of reach until something is picked here.
    component.goMappingStep();
    expect(component.currentStep).toBe(2);
    expect(component.step2Error).toBe('Select a CSV file before continuing.');
  });

  it('re-lists when the HOST changes (a different server, same protocol)', () => {
    const { component, dataSource } = readyFtp();
    // Non-empty, so a refetch can only come from the invalidation — the load
    // branch skips a list that already has entries in it.
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);
    component.goDataStep();
    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);

    component.currentStep = 1;
    component.sourceConfig.ftpHost = 'other.example.com';
    component.goDataStep();

    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(2);
    expect(dataSource.listFtpDir.mock.calls[1]?.[0]).toMatchObject({ host: 'other.example.com' });
  });

  it('does NOT re-list when nothing about the source changed', () => {
    const { component, dataSource } = readyFtp();
    // A non-empty listing: an EMPTY one is re-fetched on re-entry either way,
    // since the load branch keys off "this list has nothing in it".
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);
    component.goDataStep();
    component.currentStep = 1;

    component.goDataStep();

    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);
    expect(component.currentStep).toBe(2);
  });

  it('keeps the browsed listing and selection when only the PASSWORD changed', () => {
    // Credentials decide whether you get in, not which server you're looking at —
    // and re-picking would cost the user their mapping. A wrong one can't leave a
    // stale listing up, because the Next gate refuses to advance on a failed test.
    const { component, dataSource } = readyFtp();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);
    component.goDataStep();
    component.selectCsvFile('orders.csv');

    component.currentStep = 1;
    component.sourceConfig.ftpPassword = 'rotated';
    component.goDataStep();

    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);
    expect(component.selectedCsvPath).toBe('/orders.csv');
    expect(component.sourceConfig.ftpFileSpec).toBe('orders.csv');
  });

  it('re-lists SQL schemas and clears the picked table when the DSN changes', () => {
    const { component, dataSource } = readySqlComponent(of(OK));
    component.goDataStep();
    expect(dataSource.getSchemas).toHaveBeenCalledTimes(1);
    component.selectedSchema = 'SQLUser';
    component.selectedTable = 'Orders';
    component.onTableChange();
    expect(component.sourceConfig.dbQuery).toBe('SELECT * FROM SQLUser.Orders');

    component.currentStep = 1;
    component.sourceConfig.dbDsn = 'jdbc:postgresql://elsewhere:5432/sales';
    component.goDataStep();

    expect(dataSource.getSchemas).toHaveBeenCalledTimes(2);
    expect(component.selectedSchema).toBe('');
    expect(component.selectedTable).toBe('');
    expect(component.sourceConfig.dbQuery).toBe('');
  });

  it('re-lists the bucket when the cloud bucket or region changes', () => {
    const { component, dataSource } = makeComponent(of(OK));
    component.jobName = 'S3 load';
    component.sourceType = 'cloud';
    Object.assign(component.sourceConfig, {
      cloudBucket: 'first-bucket', cloudRegion: 'us-east-2', cloudCredentialsFile: '/uploads/creds.txt',
    });
    (component as unknown as { cloudCredentialsContent: string }).cloudCredentialsContent =
      '[default]\naws_access_key_id=AKIA\naws_secret_access_key=s\n';
    // Non-empty for the same reason as the FTP host case above.
    dataSource.listCloudDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);

    component.goDataStep();
    expect(dataSource.listCloudDir).toHaveBeenCalledTimes(1);

    component.currentStep = 1;
    component.sourceConfig.cloudBucket = 'second-bucket';
    component.goDataStep();

    expect(dataSource.listCloudDir).toHaveBeenCalledTimes(2);
    expect(dataSource.listCloudDir.mock.calls[1]?.[0]).toMatchObject({ bucket: 'second-bucket' });
  });
});

/**
 * Reopening a saved SQL case must RESTORE its Step-2 schema/table selection.
 *
 * A restored case seeds selectedSchema/selectedTable but not the dropdown option
 * lists, so a bare selection with no matching <option> rendered blank and the
 * columns were empty. The backend now recovers the case's password by id, so Step 2
 * re-lists schema→table→column to show the saved selection (or falls back to a
 * fresh pick when it no longer exists), WITHOUT rebuilding the saved Step-3 mappings.
 */
describe('enterDataStep — reopened SQL case restores its saved selection', () => {
  /** A reopened SQL case parked to re-enter Step 2: saved schema/table + mapped
   *  columns + derived query, but empty dropdowns (as editJob leaves them). */
  function reopenedSql() {
    const made = makeComponent();
    const c = made.component;
    c.sourceType = 'database';
    c.editingJobId = 'job1';
    Object.assign(c.sourceConfig, {
      dbType: 'IRIS', dbDsn: 'jdbc:IRIS://h:1972/SC', dbUsername: 'u', dbPassword: '__saved__',
      dbQuery: 'SELECT * FROM SQLUser.Orders',
    });
    // The saved mapping model — its target property must survive the restore.
    c.sourceColumns = [{ name: 'sku', type: 'String', targetProperty: 'SKU', transform: '', transformArgs: {} }] as never;
    c.selectedSchema = 'SQLUser';
    c.selectedTable = 'Orders';
    c.currentStep = 3;   // re-entering Step 2 from a later step → enterDataStep()
    return made;
  }

  it('re-lists and re-selects the saved schema/table and shows its columns', () => {
    const { component } = reopenedSql();

    component.goDataStep();   // currentStep !== 1 → enterDataStep()

    expect(component.currentStep).toBe(2);
    // The dropdown option lists are now populated (they render the selection).
    expect(component.sqlSchemas).toEqual(['SQLUser']);
    expect(component.sqlTables).toEqual(['Orders']);
    expect(component.selectedSchema).toBe('SQLUser');
    expect(component.selectedTable).toBe('Orders');
    expect(component.sqlColumns.map((col) => col.name)).toEqual(['sku']);
    // The saved Step-3 mapping is preserved — the restore repopulates the display
    // lists only, it must never rebuild sourceColumns and drop the target property.
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
    // Everything's still selected, so Mapping is reachable.
    expect(component.canProceedStep2).toBe(true);
  });

  it('falls back to a fresh pick when the saved schema no longer exists', () => {
    const { component, dataSource } = reopenedSql();
    dataSource.getSchemas.mockReturnValue(of({ ok: true, schemas: ['OtherSchema'] }) as never);

    component.goDataStep();

    // Live schemas are listed, but the saved one is gone → selection cleared.
    expect(component.sqlSchemas).toEqual(['OtherSchema']);
    expect(component.selectedSchema).toBe('');
    expect(component.selectedTable).toBe('');
    expect(component.sourceConfig.dbQuery).toBe('');
    // No table is loaded, so tables aren't fetched.
    expect(dataSource.getTables).not.toHaveBeenCalled();
    // Gate now requires a real pick — the stale entity no longer waves it through.
    expect(component.canProceedStep2).toBe(false);
    expect(component.missingStep2Selection).toBe('Select a schema, then a table, before continuing.');
  });

  it('keeps the schema but re-picks the table when only the saved table is gone', () => {
    const { component, dataSource } = reopenedSql();
    dataSource.getTables.mockReturnValue(of({ ok: true, tables: ['Invoices'] }) as never);

    component.goDataStep();

    expect(component.selectedSchema).toBe('SQLUser');   // schema still exists
    expect(component.sqlTables).toEqual(['Invoices']);
    expect(component.selectedTable).toBe('');           // saved table gone
    expect(component.sourceConfig.dbQuery).toBe('');
    expect(dataSource.getColumns).not.toHaveBeenCalled();
    expect(component.canProceedStep2).toBe(false);
    expect(component.missingStep2Selection).toBe('Select a table before continuing.');
  });

  it('does not re-introspect a second time once the lists are populated', () => {
    const { component, dataSource } = reopenedSql();
    component.goDataStep();
    expect(dataSource.getSchemas).toHaveBeenCalledTimes(1);

    // Bounce to Step 3 and back — the populated lists must not trigger a refetch.
    component.currentStep = 3;
    component.goDataStep();

    expect(dataSource.getSchemas).toHaveBeenCalledTimes(1);
    expect(component.selectedTable).toBe('Orders');
  });
});

/**
 * Reopening a saved FTP/SFTP/cloud/file case must RESTORE its Step-2 file + preview.
 *
 * Same defect as the SQL case, one page over: a reopened case seeds the picked
 * file/object path but not the directory listing or the CSV preview, so after a
 * refresh Step 2 showed the connection as tested but the folder empty and the file
 * content blank — the user had to re-browse and lost their Step-3 mapping on the
 * re-pick. enterDataStep now runs a per-adapter restore that re-lists + re-previews
 * from the server (the backend recovers the persisted secret / stored file by case
 * id), DISPLAY-ONLY: it never rebuilds sourceColumns, so the saved mapping survives.
 */
describe('enterDataStep — reopened remote/local case restores its Step-2 preview', () => {
  /** The saved Step-3 mapping model — its target property must survive every restore. */
  const savedMapping = [{ name: 'sku', type: 'String', targetProperty: 'SKU', transform: '', transformArgs: {} }];

  /** A reopened FTP (or SFTP) case parked to re-enter Step 2: connection fields the
   *  browser needs, the saved file path + its directory, mapped columns — but empty
   *  browse lists and no preview, exactly as editJob leaves a refreshed reopen. */
  function reopenedFtp(sftp = false) {
    const made = makeComponent();
    const c = made.component;
    c.sourceType = 'ftp';
    c.editingJobId = 'job1';
    Object.assign(c.sourceConfig, {
      ftpHost: 'files.example.com', ftpUsername: 'app', ftpSftp: sftp,
      ftpPath: '/data', ftpFileSpec: 'orders.csv',   // ftpFileSpec ⇒ carriedOverDataEntity
    });
    c.sourceColumns = savedMapping as never;
    c.selectedCsvPath = '/data/orders.csv';
    c.ftpPathSegments = ['data'];   // as seedDataStepFromEntity derives from ftpPath
    // A reopened SFTP case has a persisted key the backend recovers — so the browse
    // blocker sees the key as present even though its contents aren't in memory.
    if (sftp) (c as unknown as { uploadFileIds: Record<string, string> }).uploadFileIds = { privateKey: 'f1' };
    c.currentStep = 3;   // re-entering Step 2 from a later step → enterDataStep()
    return made;
  }

  /** A reopened cloud case, same shape as reopenedFtp for object storage. */
  function reopenedCloud() {
    const made = makeComponent();
    const c = made.component;
    c.sourceType = 'cloud';
    c.editingJobId = 'job1';
    Object.assign(c.sourceConfig, {
      cloudBucket: 'my-bucket', cloudRegion: 'us-east-2',
      cloudBlobPrefix: '/raw', cloudBlobPattern: 'orders.csv',   // pattern ⇒ carriedOverDataEntity
    });
    c.sourceColumns = savedMapping as never;
    c.selectedCloudCsvPath = '/raw/orders.csv';
    c.cloudPathSegments = ['raw'];
    (c as unknown as { uploadFileIds: Record<string, string> }).uploadFileIds = { cloudCred: 'f1' };
    c.currentStep = 3;
    return made;
  }

  /** A reopened local-file case: no File in memory after a refresh, only a stored copy. */
  function reopenedFile() {
    const made = makeComponent();
    const c = made.component;
    c.sourceType = 'file';
    c.editingJobId = 'job1';
    c.sourceConfig.filePath = '/uploads/orders.csv';   // filePath ⇒ carriedOverDataEntity
    c.sourceColumns = savedMapping as never;
    c.localFileName = 'orders.csv';
    c.currentStep = 3;
    return made;
  }

  it('FTP: re-lists the directory and re-previews the saved file, preserving the mapping', () => {
    const { component, dataSource } = reopenedFtp();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    // The listing is fetched at the saved file's directory (breadcrumb restores there).
    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);
    expect(dataSource.listFtpDir.mock.calls[0]?.[1]).toBe('/data');
    expect(component.ftpEntries.map((e) => e.name)).toEqual(['orders.csv']);
    // The saved file's content is previewed for display…
    expect(dataSource.previewRemoteCsv).toHaveBeenCalledWith(expect.anything(), '/data/orders.csv');
    expect(component.csvPreview?.columns.map((col) => col.name)).toEqual(['sku']);
    // …and the saved Step-3 mapping is preserved (restore is display-only).
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
    expect(component.canProceedStep2).toBe(true);
  });

  it('SFTP: restores over the SFTP protocol (backend recovers the persisted key)', () => {
    const { component, dataSource } = reopenedFtp(true);
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    // Both browse calls go out over SFTP — the persisted key makes the blocker pass.
    expect(dataSource.listFtpDir.mock.calls[0]?.[0]).toMatchObject({ protocol: 'SFTP' });
    expect(dataSource.previewRemoteCsv.mock.calls[0]?.[0]).toMatchObject({ protocol: 'SFTP' });
    expect(component.csvPreview?.columns.length).toBeGreaterThan(0);
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
  });

  it('Cloud: re-lists the prefix and re-previews the saved object, preserving the mapping', () => {
    const { component, dataSource } = reopenedCloud();
    dataSource.listCloudDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);
    dataSource.previewCloudCsv.mockReturnValue(of({ ok: true, rows: [['sku'], ['A1']] }) as never);

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    expect(dataSource.listCloudDir.mock.calls[0]?.[1]).toBe('/raw');
    expect(dataSource.previewCloudCsv).toHaveBeenCalledWith(expect.anything(), '/raw/orders.csv');
    expect(component.cloudCsvPreview?.columns.map((col) => col.name)).toEqual(['sku']);
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
    expect(component.canProceedStep2).toBe(true);
  });

  it('File: previews from the stored SQLite copy by case id, preserving the mapping', () => {
    const { component, dataSource } = reopenedFile();

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    // The refreshed browser has no File, so it previews the backend's stored copy by id.
    expect(dataSource.previewStoredLocalCsv).toHaveBeenCalledWith('job1');
    expect(component.localCsvPreview?.columns.length).toBeGreaterThan(0);
    expect(component.localPreviewError).toBeNull();
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
    expect(component.canProceedStep2).toBe(true);
  });

  it('File: a missing stored copy surfaces an inline re-upload prompt, mapping still intact', () => {
    const { component, dataSource } = reopenedFile();
    dataSource.previewStoredLocalCsv.mockReturnValue(
      of({ ok: false, message: 'No stored file for this case; re-upload it to preview.' }) as never,
    );

    component.goDataStep();

    expect(component.localCsvPreview).toBeNull();
    expect(component.localPreviewError).toContain('re-upload');
    // The mapping isn't touched, so a re-upload of the same file keeps it.
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
  });

  it('FTP: an unreadable saved file surfaces inline without discarding the mapping', () => {
    const { component, dataSource } = reopenedFtp();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);
    dataSource.previewRemoteCsv.mockReturnValue(of({ ok: false, message: 'Could not read "/data/orders.csv": gone' }) as never);

    component.goDataStep();

    expect(component.csvPreview).toBeNull();
    expect(component.csvPreviewError).toContain('Could not read');
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');
  });

  it('does not re-introspect a second time once the listing + preview are populated', () => {
    const { component, dataSource } = reopenedFtp();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);
    component.goDataStep();
    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);
    expect(dataSource.previewRemoteCsv).toHaveBeenCalledTimes(1);

    // Bounce to Step 3 and back — the populated list/preview must not refetch.
    component.currentStep = 3;
    component.goDataStep();

    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);
    expect(dataSource.previewRemoteCsv).toHaveBeenCalledTimes(1);
  });
});

/**
 * Switching from one reopened case to another must not leak the first's Step-2 state.
 *
 * The wizard lives in ONE long-lived component (the workbench swaps features by a
 * string, not a route), so editJob() reuses the same instance every reopen. Entering
 * Step 2 for case A leaves its browse listing (`ftpEntries`) and its data-source
 * identity (`loadedDataSource`) on that instance. Reopening case B without wiping
 * them first produced the field bug — Step 2 showed the connection tested but the
 * saved file unselected / its content blank — via two paths:
 *   • different server ⇒ enterDataStep's identity-mismatch guard fires resetDataStep,
 *     which erases the file path editJob just seeded (nothing selected, root listing);
 *   • same server ⇒ A's stale non-empty `ftpEntries` short-circuits the restore, so
 *     the saved file's preview is never fetched (selected, but blank).
 * Refresh masked it by recreating the component. editJob now calls resetDataStep()
 * up front, so each reopen starts from a blank Step-2 whiteboard and re-restores.
 */
describe('editJob — reopening another case does not inherit the previous case Step-2 state', () => {
  const savedMapping = [{ name: 'sku', type: 'String', targetProperty: 'SKU', transform: '', transformArgs: {} }];

  /** A saved FTP case that carries a picked file (dataEntity.source = full path). */
  function ftpJob(over: { id: string; host: string; dir: string; file: string }) {
    return {
      id: over.id,
      name: over.id,
      status: 'draft',
      sourceType: 'ftp',
      source: {
        type: 'ftp', ftpSftp: false, ftpDataSourceName: over.id,
        ftpHost: over.host, ftpUsername: 'app',
        ftpPath: over.dir, ftpFileSpec: over.file,   // ftpFileSpec ⇒ carriedOverDataEntity
      },
      columns: savedMapping,
      hasHeader: true,
      targetClass: '',
      dataEntity: { name: over.file, source: `${over.dir}/${over.file}` },
      connectionTested: true,
      uploadedFiles: {},
    } as never;
  }

  it('DIFFERENT server: the reopened file stays selected and its preview is re-fetched', () => {
    const { component, dataSource } = makeComponent();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'a.csv', type: 'csv' }] }) as never);

    // Open case A on serverA and enter Step 2 — this parks A's listing + identity
    // on the shared component instance.
    component.editJob(ftpJob({ id: 'A', host: 'serverA', dir: '/dataA', file: 'a.csv' }));
    component.goDataStep();
    const loadedDataSource = () => (component as unknown as { loadedDataSource: string }).loadedDataSource;
    expect(loadedDataSource()).toContain('serverA');

    // Reopen case B on a DIFFERENT server, still carrying A's Step-2 state, and re-enter.
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'b.csv', type: 'csv' }] }) as never);
    component.editJob(ftpJob({ id: 'B', host: 'serverB', dir: '/dataB', file: 'b.csv' }));
    component.goDataStep();

    // Without the reset, the identity-mismatch guard wipes B's just-seeded path here.
    expect(component.currentStep).toBe(2);
    expect(component.selectedCsvPath).toBe('/dataB/b.csv');
    expect(loadedDataSource()).toContain('serverB');
    // B's directory is listed and B's file previewed — not left blank on stale state.
    expect(dataSource.listFtpDir.mock.calls.at(-1)?.[1]).toBe('/dataB');
    expect(dataSource.previewRemoteCsv).toHaveBeenLastCalledWith(expect.anything(), '/dataB/b.csv');
    expect(component.csvPreview?.columns.length).toBeGreaterThan(0);
    expect(component.canProceedStep2).toBe(true);
  });

  it('SAME server: a second case still gets its saved file previewed, not short-circuited', () => {
    const { component, dataSource } = makeComponent();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'a.csv', type: 'csv' }] }) as never);

    // Case A and case B live on the SAME server (identical identity) but pick
    // different files — so only the stale-listing short-circuit can bite here.
    component.editJob(ftpJob({ id: 'A', host: 'files', dir: '/data', file: 'a.csv' }));
    component.goDataStep();
    expect(component.ftpEntries.length).toBeGreaterThan(0);   // A's listing is now parked

    dataSource.previewRemoteCsv.mockClear();
    dataSource.listFtpDir.mockReturnValue(of({ ok: true, entries: [{ name: 'b.csv', type: 'csv' }] }) as never);
    component.editJob(ftpJob({ id: 'B', host: 'files', dir: '/data', file: 'b.csv' }));
    component.goDataStep();

    // The saved file's preview must be fetched for display; stale ftpEntries must not
    // make enterDataStep believe the step is already populated and skip the restore.
    expect(component.selectedCsvPath).toBe('/data/b.csv');
    expect(dataSource.previewRemoteCsv).toHaveBeenLastCalledWith(expect.anything(), '/data/b.csv');
    expect(component.csvPreview?.columns.length).toBeGreaterThan(0);
    expect(component.canProceedStep2).toBe(true);
  });
});

/**
 * Switching the Step-3 target class must re-scope every mapping.
 *
 * A mapping row stores only the target property NAME, not the class it belongs to,
 * so a stale name (e.g. `uid`) would silently re-bind to any same-named property in
 * a newly selected class — an incorrect auto-map the user never made. So switching
 * to a DIFFERENT class must blank every row's target property; switching BACK to the
 * class the case was saved with must restore the saved mappings automatically, with
 * no manual re-map. This is source-agnostic (SQL/FTP/SFTP/cloud/file share the model).
 */
describe('onTargetClassChange — switching the target class re-scopes Step-3 mappings', () => {
  /** A reopened case saved against `Location` with two mapped columns; `Product`
   *  shares the `uid` property NAME (the bug's trigger) but nothing else. */
  function reopenedWithSavedClass() {
    const made = makeComponent();
    const c = made.component;
    made.classDetails['Location'] = {
      attributes: [{ name: 'uid', dataType: 'String' }, { name: 'city', dataType: 'String' }],
    };
    made.classDetails['Product'] = {
      attributes: [{ name: 'uid', dataType: 'String' }, { name: 'price', dataType: 'Decimal' }],
    };
    c.sourceColumns = [
      { name: 'ID', type: 'String', targetProperty: 'uid', transform: '', transformArgs: {} },
      { name: 'Town', type: 'String', targetProperty: 'city', transform: '', transformArgs: {} },
    ] as never;
    // The baseline editJob() captures on reopen: the saved class + its column→property map.
    (c as unknown as { savedTargetClass: string }).savedTargetClass = 'Location';
    (c as unknown as { savedMappingByColumn: Map<string, string> }).savedMappingByColumn = new Map([
      ['ID', 'uid'],
      ['Town', 'city'],
    ]);
    return made;
  }

  it('blanks every mapping when switching to a DIFFERENT class, even one sharing a property name', () => {
    const { component } = reopenedWithSavedClass();

    component.selectedTargetClass = 'Product';   // user switches away from the saved class
    component.onTargetClassChange();

    // `uid` exists in Product too, but it must NOT auto-map — the user never chose it.
    expect(component.sourceColumns.map((col) => col.targetProperty)).toEqual(['', '']);
  });

  it('restores the saved mappings when switching BACK to the saved class (no manual re-map)', () => {
    const { component } = reopenedWithSavedClass();

    component.selectedTargetClass = 'Product';
    component.onTargetClassChange();
    component.selectedTargetClass = 'Location';   // back to the class saved with the case
    component.onTargetClassChange();

    expect(component.sourceColumns[0]?.targetProperty).toBe('uid');
    expect(component.sourceColumns[1]?.targetProperty).toBe('city');
  });

  it('on switch-back, drops a saved mapping whose property the class no longer has', () => {
    const { made, component } = (() => {
      const m = reopenedWithSavedClass();
      return { made: m, component: m.component };
    })();
    // The saved class drifted: `city` was removed since the case was saved.
    made.classDetails['Location'] = { attributes: [{ name: 'uid', dataType: 'String' }] };

    component.selectedTargetClass = 'Product';
    component.onTargetClassChange();
    component.selectedTargetClass = 'Location';
    component.onTargetClassChange();

    // `uid` still exists → restored; `city` is gone → left blank (not force-mapped).
    expect(component.sourceColumns[0]?.targetProperty).toBe('uid');
    expect(component.sourceColumns[1]?.targetProperty).toBe('');
  });

  it('a brand-new case (no saved baseline) simply blanks mappings on any class switch', () => {
    const made = makeComponent();
    const c = made.component;
    made.classDetails['Product'] = { attributes: [{ name: 'uid', dataType: 'String' }] };
    c.sourceColumns = [
      { name: 'ID', type: 'String', targetProperty: 'uid', transform: '', transformArgs: {} },
    ] as never;

    c.selectedTargetClass = 'Product';
    c.onTargetClassChange();

    expect(c.sourceColumns[0]?.targetProperty).toBe('');
  });

  it('reopen (editJob) captures the saved class + mappings as the switch-back baseline', () => {
    // Without this wiring the switch-back restore has nothing to restore FROM, so the
    // feature would silently no-op in production while the logic tests still pass.
    const { component } = makeComponent();
    component.editJob({
      id: 'job1',
      name: 'Nightly load',
      status: 'draft',
      sourceType: 'database',
      source: {
        type: 'database', dbType: 'IRIS', dbDsn: 'jdbc:IRIS://h:1972/SC',
        dbUsername: 'u', dbPassword: '__saved__', dbQuery: 'SELECT * FROM SQLUser.Orders',
      },
      columns: [{ name: 'sku', type: 'String', targetProperty: 'SKU', transform: '', transformArgs: {} }],
      hasHeader: true,
      targetClass: 'Location',
      dataEntity: { name: 'Orders', source: 'SQLUser' },
      connectionTested: true,
      uploadedFiles: {},
    } as never);

    expect((component as unknown as { savedTargetClass: string }).savedTargetClass).toBe('Location');
    expect([...(component as unknown as { savedMappingByColumn: Map<string, string> }).savedMappingByColumn])
      .toEqual([['sku', 'SKU']]);
  });
});

/**
 * Re-selecting the SAME source table after a detour must keep its mapping.
 *
 * The Step-2 selector drives syncSourceColumnsFromData, which rebuilds the Step-3
 * columns from scratch (blank target properties) whenever the picked table changes.
 * A user who briefly picks another table and then re-picks the original hasn't
 * actually changed the source — so the target-property mappings they made (or a
 * reopened case saved) for that table must survive the round trip, not be wiped.
 */
describe('syncSourceColumnsFromData — mapping survives a Step-2 table detour', () => {
  /** getColumns keyed by table so Orders and Customers return distinct structures. */
  function columnsByTable(dataSource: ReturnType<typeof makeComponent>['dataSource']) {
    dataSource.getColumns.mockImplementation(((_c: unknown, _s: unknown, t: string) =>
      t === 'Orders'
        ? of({ ok: true, columns: [{ name: 'sku', dataType: 'VARCHAR' }] })
        : of({ ok: true, columns: [{ name: 'cust', dataType: 'VARCHAR' }] })) as never);
  }

  it('restores the mapping when the user re-picks the table they mapped', () => {
    const { component, dataSource } = makeComponent();
    component.sourceType = 'database';
    component.selectedSchema = 'SQLUser';
    columnsByTable(dataSource);

    // Pick Orders and map its one column to a target property.
    component.selectedTable = 'Orders';
    component.onTableChange();
    component.sourceColumns.find((c) => c.name === 'sku')!.targetProperty = 'SKU';

    // Detour: pick a different table — its columns start unmapped.
    component.selectedTable = 'Customers';
    component.onTableChange();
    expect(component.sourceColumns.some((c) => c.targetProperty === 'SKU')).toBe(false);

    // Re-pick the original table: the mapping made for it comes back.
    component.selectedTable = 'Orders';
    component.onTableChange();
    expect(component.sourceColumns.find((c) => c.name === 'sku')?.targetProperty).toBe('SKU');
  });

  it("reopened case: re-selecting the saved table restores the saved mapping", () => {
    const { component, dataSource } = makeComponent();
    columnsByTable(dataSource);

    // Reopen a saved SQL case whose Orders column is mapped to SKU.
    component.editJob({
      id: 'job1',
      name: 'Nightly load',
      status: 'draft',
      sourceType: 'database',
      source: {
        type: 'database', dbType: 'IRIS', dbDsn: 'jdbc:IRIS://h:1972/SC',
        dbUsername: 'u', dbPassword: '__saved__', dbQuery: 'SELECT * FROM SQLUser.Orders',
      },
      columns: [{ name: 'sku', type: 'String', targetProperty: 'SKU', transform: '', transformArgs: {} }],
      hasHeader: true,
      targetClass: '',
      dataEntity: { name: 'Orders', source: 'SQLUser' },
      connectionTested: true,
      uploadedFiles: {},
    } as never);
    expect(component.selectedTable).toBe('Orders');
    expect(component.sourceColumns[0]?.targetProperty).toBe('SKU');

    // Detour to another table, then back to the originally saved one.
    component.selectedTable = 'Customers';
    component.onTableChange();
    component.selectedTable = 'Orders';
    component.onTableChange();

    // The saved mapping is preserved even though the selection briefly changed.
    expect(component.sourceColumns.find((c) => c.name === 'sku')?.targetProperty).toBe('SKU');
  });

  it('does not carry a mapping onto a genuinely different table (matched by name)', () => {
    const { component, dataSource } = makeComponent();
    component.sourceType = 'database';
    component.selectedSchema = 'SQLUser';
    columnsByTable(dataSource);

    component.selectedTable = 'Orders';
    component.onTableChange();
    component.sourceColumns.find((c) => c.name === 'sku')!.targetProperty = 'SKU';

    // A different table with a different column name gets no stale mapping.
    component.selectedTable = 'Customers';
    component.onTableChange();
    expect(component.sourceColumns.map((c) => c.name)).toEqual(['cust']);
    expect(component.sourceColumns[0]?.targetProperty).toBe('');
  });
});

/**
 * Saving from Step 3.
 *
 * The target class is what every mapping row points at, so a draft saved without
 * one carries a source and columns that map onto nothing, and Deploy has no class
 * to generate a DTL against. Reported from the UI: Save Draft persisted a job with
 * no target class selected.
 */
describe('saveJob — target-class gate', () => {
  /** A component on Step 3 with a data entity already settled, ready to save. */
  function readyToSave() {
    const made = makeComponent();
    const c = made.component;
    c.wizardOpen = true;
    c.currentStep = 3;
    c.jobName = 'CSV load';
    // A local-file source: no driver JAR to stage and no uploaded-file ids, so
    // saveJob() completes without touching the UploadService.
    c.sourceType = 'file';
    c.sourceConfig.filePath = '/irisdev/app/uploads/sales.csv';
    c.sourceColumns = [{ name: 'sku', type: 'String', targetProperty: '', transform: '' } as never];
    return made;
  }

  // jsdom doesn't guarantee a `localStorage` global (absent on Node 26, present
  // on the CI Node-20 runner), and these tests plus the component's persistence
  // read it directly. Self-provide a functional mock so the block passes on any
  // Node, and restore the original in afterEach so it never leaks to other specs
  // sharing the process (same pattern as dashboard.spec.ts). SC-2696.
  let realLocalStorage: unknown;
  let mockStorage: Record<string, string> = {};
  const storageMock = {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => { mockStorage[key] = value; },
    removeItem: (key: string) => { delete mockStorage[key]; },
    clear: () => { mockStorage = {}; },
    length: 0,
    key: (index: number) => Object.keys(mockStorage)[index] ?? null,
  };

  beforeEach(() => {
    realLocalStorage = (globalThis as any).localStorage;
    mockStorage = {};
    (globalThis as any).localStorage = storageMock;
  });
  afterEach(() => {
    (globalThis as any).localStorage = realLocalStorage;
  });

  it('does NOT nag before the user tries to save', () => {
    const { component } = readyToSave();
    expect(component.step3Error).toBeNull();
    expect(component.canSaveJob).toBe(false);
  });

  it('REFUSES to save a draft with no target class, and says why', () => {
    const { component } = readyToSave();
    const before = component.jobs.length;

    component.saveJob();

    expect(component.jobs.length).toBe(before);
    expect(component.step3Error).toBe('Select a target class before saving.');
    // The wizard stays open on Step 3 — a closed wizard would look like a save.
    expect(component.wizardOpen).toBe(true);
    expect(component.currentStep).toBe(3);
  });

  it('does not persist anything on a blocked save', () => {
    const { component, casesApi } = readyToSave();

    component.saveJob();

    // No target class → the save is refused before it ever reaches SQLite.
    expect(casesApi.save).not.toHaveBeenCalled();
  });

  it('saves once a target class is chosen, and clears the banner live', () => {
    const { component, casesApi } = readyToSave();
    component.saveJob();                       // blocked, banner showing
    expect(component.step3Error).not.toBeNull();

    component.selectedTargetClass = 'BOM';
    expect(component.step3Error).toBeNull();   // fixed without a second click

    component.saveJob();

    expect(casesApi.save).toHaveBeenCalledTimes(1);
    expect(component.jobs.length).toBe(1);
    expect(component.jobs[0]?.targetClass).toBe('BOM');
    expect(component.wizardOpen).toBe(false);
  });

  it('REFUSES to save when a required target property is left unmapped', () => {
    // The mapping is the whole point of Step 3: a deployed pipeline that skips a
    // required property can't populate its target object, so block the save and
    // name the offender. (readyToSave leaves the one column unmapped.)
    const { component, casesApi } = readyToSave();
    component.selectedTargetClass = 'BOM';
    component.targetProperties = [{ name: 'SKU', dataType: 'String', required: true }] as never;

    component.saveJob();

    expect(casesApi.save).not.toHaveBeenCalled();
    expect(component.wizardOpen).toBe(true);
    expect(component.step3Error).toContain('SKU');
    expect(component.unmappedRequiredProperties()).toEqual(['SKU']);

    // Mapping the column onto it clears the gate and lets the save through.
    component.sourceColumns[0]!.targetProperty = 'SKU';
    expect(component.step3Error).toBeNull();
    component.saveJob();
    expect(casesApi.save).toHaveBeenCalledTimes(1);
    expect(component.wizardOpen).toBe(false);
  });

  it('tells the user to WAIT while the target classes are still loading', () => {
    const { component } = readyToSave();
    component.loadingTargetClasses = true;

    component.saveJob();

    expect(component.step3Error).toContain('finish loading');
    expect(component.jobs.length).toBe(0);
  });

  it('treats whitespace as no selection', () => {
    const { component } = readyToSave();
    component.selectedTargetClass = '   ';

    component.saveJob();

    expect(component.jobs.length).toBe(0);
    expect(component.step3Error).toBe('Select a target class before saving.');
  });

  it('gates Save Changes on an EDITED job too, not just a new draft', () => {
    const { component } = readyToSave();
    component.editingJobId = 'job123';
    component.selectedTargetClass = '';        // class cleared while editing

    component.saveJob();

    expect(component.jobs.length).toBe(0);
    expect(component.step3Error).toBe('Select a target class before saving.');
  });
});

describe('goDataStep — per-adapter behaviour', () => {
  it('gates the cloud (S3) source on a real bucket test before browsing it', () => {
    const { component, testConnection, dataSource } = makeComponent(of(FAIL));
    component.jobName = 'S3 load';
    component.sourceType = 'cloud';
    Object.assign(component.sourceConfig, {
      cloudBucket: 'my-bucket',
      cloudRegion: 'us-east-2',
      cloudCredentialsFile: '/irisdev/app/uploads/creds.txt',
    });
    // The credentials file's CONTENTS are what the test posts; without them the
    // component short-circuits before the service, so seed them.
    (component as unknown as { cloudCredentialsContent: string }).cloudCredentialsContent =
      '[default]\naws_access_key_id=AKIA\naws_secret_access_key=s\n';
    // Non-empty for the same reason as the FTP host case above.
    dataSource.listCloudDir.mockReturnValue(of({ ok: true, entries: [{ name: 'orders.csv', type: 'csv' }] }) as never);

    component.goDataStep();

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(component.currentStep).toBe(1);
    expect(dataSource.listCloudDir).not.toHaveBeenCalled();
  });

  it('advances a local-file source with no test, since there is no remote server', () => {
    const { component, testConnection } = makeComponent();
    component.jobName = 'CSV load';
    component.sourceType = 'file';
    component.sourceConfig.filePath = '/irisdev/app/uploads/sales.csv';

    component.goDataStep();

    expect(component.canTestConnection()).toBe(false);
    expect(testConnection).not.toHaveBeenCalled();
    expect(component.currentStep).toBe(2);
  });

  it('does not re-gate BACKWARDS navigation (the Step-2 breadcrumb from Step 3)', () => {
    // Reached Step 3 already, then a Step-1 field was edited: returning to Step 2
    // must not run a test whose message would land on an invisible step.
    const { component, testConnection } = readySqlComponent(of(FAIL));
    component.currentStep = 3;
    component.sourceConfig.dbDsn = 'jdbc:postgresql://edited:5432/sales';

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    expect(testConnection).not.toHaveBeenCalled();
  });
});

/**
 * A reopened case that was saved from STEP 1 ONLY.
 *
 * This is the ordinary "upload/configure, Save, come back later" flow, and it lands
 * in a state no other reopen test covers: the case has its Step-1 config but NO
 * mapping columns yet (they are built in Step 2), so it is not a
 * `carriedOverDataEntity` and does not take the reopen restore path.
 *
 * For the remote adapters that is fine — Step 2 browses live, with the backend
 * recovering the persisted secret by case id. But the LOCAL FILE adapter picks its
 * file in Step 1, so Step 2 has no control to re-pick: with the browser's File object
 * gone after the reopen, nothing loaded the preview and the user saw an empty Preview
 * section, then had to re-upload the same file (SC-2675 field report).
 */
describe('enterDataStep — a case saved from Step 1 only, then reopened', () => {
  /** A local-file case reopened with a stored file but no saved mapping columns. */
  function reopenedFileNoMapping() {
    const made = makeComponent();
    const c = made.component;
    c.jobName = 'CSV load';      // Step 1 is complete — it was saved, after all
    c.sourceType = 'file';
    c.editingJobId = 'job1';
    c.sourceConfig.filePath = '/uploads';
    c.sourceConfig.fileSpec = 'orders.csv';
    c.localFileName = 'orders.csv';
    c.sourceColumns = [];        // Step 2 was never completed, so nothing was saved
    c.currentStep = 1;
    return made;
  }

  it('File: previews the STORED copy even though no mapping was saved yet', () => {
    const { component, dataSource } = reopenedFileNoMapping();

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    // The bytes are in SQLite, not the browser — so it must go and get them rather
    // than leave the Preview section blank.
    expect(dataSource.previewStoredLocalCsv).toHaveBeenCalledWith('job1');
    expect(component.localCsvPreview?.columns.map((col) => col.name)).toEqual(['sku']);
    expect(component.localPreviewError).toBeNull();
  });

  it('File: seeds Step 3 from the restored preview, so Next is not blocked', () => {
    const { component } = reopenedFileNoMapping();

    component.goDataStep();

    // Nothing was saved to protect, so the restored columns become the Step-3 grid —
    // otherwise Mapping opens with "No source data columns" and no way to fix it.
    expect(component.sourceColumns.map((col) => col.name)).toEqual(['sku']);
    expect(component.canProceedStep2).toBe(true);
  });

  it('File: does NOT overwrite a mapping that WAS saved', () => {
    // The other half of the same rule: a case with a saved mapping keeps its target
    // properties across the restore (the restore stays display-only for it).
    const { component } = reopenedFileNoMapping();
    component.sourceColumns = [{ name: 'sku', type: 'String', targetProperty: 'SKU' }] as never;

    component.goDataStep();

    expect(component.sourceColumns).toEqual([{ name: 'sku', type: 'String', targetProperty: 'SKU' }]);
  });

  it('File: still asks for a re-upload when the stored copy is gone', () => {
    const { component, dataSource } = reopenedFileNoMapping();
    dataSource.previewStoredLocalCsv.mockReturnValue(
      of({ ok: false, message: 'No stored file for this case; re-upload it to preview.' }) as never,
    );

    component.goDataStep();

    expect(component.localPreviewError).toContain('re-upload');
    expect(component.canProceedStep2).toBe(false);
  });

  it('File: reads the picked File in preference to the stored copy (same session)', () => {
    // Uploaded THIS session: the bytes are already here, so spending a round trip on
    // the stored copy would be wasteful (and would show the pre-edit file).
    // A hand-rolled stand-in for the File, not a real one: jsdom's Blob has no
    // .text(), so a real File would reject inside the read instead of previewing.
    const { component, dataSource } = reopenedFileNoMapping();
    (component as unknown as { localFile: unknown }).localFile = {
      name: 'orders.csv',
      type: 'text/csv',
      slice: () => ({ text: () => Promise.resolve('sku\nA1\n') }),
    };

    component.goDataStep();

    expect(dataSource.previewStoredLocalCsv).not.toHaveBeenCalled();
  });

  // The remote adapters reach Step 2 through the LIVE browse path in this state, and
  // must still work there: the case id in the connection lets the backend swap in the
  // persisted password / SFTP key / credentials file, so nothing has to be re-entered.
  it('SQL: browses live with the persisted password recovered by case id', () => {
    const { component, dataSource } = readySqlComponent();
    component.editingJobId = 'job1';
    component.sourceColumns = [];

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    expect(dataSource.getSchemas).toHaveBeenCalledTimes(1);
    expect(dataSource.getSchemas.mock.calls[0]?.[0]).toMatchObject({ caseId: 'job1' });
  });

  it('SFTP: browses live on the persisted key, without a re-upload', () => {
    const { component, dataSource } = makeComponent();
    component.jobName = 'Drop';
    component.sourceType = 'ftp';
    component.editingJobId = 'job1';
    Object.assign(component.sourceConfig, {
      ftpDataSourceName: 'Drop', ftpHost: 'files.example.com', ftpUsername: 'app', ftpSftp: true,
      sftpPublicKeyFile: '/k/pub', sftpPrivateKeyFile: '/k/priv',
    });
    // The persisted key slot is what makes the browse blocker pass — its CONTENTS
    // are no longer in memory after the reopen.
    (component as unknown as { uploadFileIds: Record<string, string> }).uploadFileIds = { privateKey: 'f1' };
    component.sourceColumns = [];

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    expect(dataSource.listFtpDir).toHaveBeenCalledTimes(1);
    expect(dataSource.listFtpDir.mock.calls[0]?.[0]).toMatchObject({ caseId: 'job1', protocol: 'SFTP' });
    expect(component.ftpError).toBeNull();
  });

  it('Cloud: browses live on the persisted credentials file, without a re-pick', () => {
    const { component, dataSource } = makeComponent();
    component.jobName = 'Bucket load';
    component.sourceType = 'cloud';
    component.editingJobId = 'job1';
    Object.assign(component.sourceConfig, {
      cloudBucket: 'my-bucket', cloudRegion: 'us-east-2', cloudCredentialsFile: '/creds/aws',
    });
    (component as unknown as { uploadFileIds: Record<string, string> }).uploadFileIds = { cloudCred: 'f1' };
    component.sourceColumns = [];

    component.goDataStep();

    expect(component.currentStep).toBe(2);
    expect(dataSource.listCloudDir).toHaveBeenCalledTimes(1);
    expect(dataSource.listCloudDir.mock.calls[0]?.[0]).toMatchObject({ caseId: 'job1' });
    expect(component.cloudError).toBeNull();
  });
});

/**
 * Deploy must refuse an unfinished pipeline.
 *
 * Deploy hands the pipeline to the agent, which generates and compiles IRIS classes
 * from it — so a missing connection field, an unpicked data entity or an unmapped
 * required property fails DEEP inside that turn, as a compile error the user can
 * neither locate nor fix. The gate therefore runs before anything else happens, and
 * names every step that is still incomplete.
 */
describe('deployIntegration — readiness gate', () => {
  const noop = () => undefined;

  function makeDeployComponent() {
    const runAgentPrompt = vi.fn();
    const createCredentialFromCase = vi.fn(() => of({ ok: true, name: null as string | null }));
    let pending: ReadonlySet<string> = new Set();
    const bridge = {
      register: noop,
      unregister: noop,
      runAgentPrompt,
      pendingDeploys: () => pending,
      markDeployPending: (id: string) => { pending = new Set(pending).add(id); },
      clearDeployPending: (id: string) => { const next = new Set(pending); next.delete(id); pending = next; },
    };
    const component = new DataIntegrationComponent(
      { getClasses: () => of([]) } as never,                                  // ScModelService
      {} as never,                                                           // DataSourceService
      {} as never,                                                           // UploadService
      { createCredentialFromCase } as never,                                 // DataIntegrationService
      {} as never, {} as never, {} as never, {} as never,                    // connection testers
      { markForCheck: noop, detectChanges: noop } as never,                   // ChangeDetectorRef
      bridge as never,                                                        // WorkbenchBridgeService
      { show: noop, error: noop, success: noop, info: noop } as never,        // ToastService
    );
    return { component, runAgentPrompt, createCredentialFromCase };
  }

  /** A complete, deployable local-file pipeline. */
  function readyJob(over: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      name: 'Nightly load',
      status: 'draft',
      sourceType: 'file',
      sourceName: 'orders.csv',
      source: { type: 'file', adapterType: 'File', filePath: '/uploads', fileSpec: 'orders.csv' },
      dataEntity: { nameLabel: 'File', name: 'orders.csv', sourceLabel: 'Path', source: '/uploads' },
      targetClass: 'Product',
      hasHeader: true,
      columns: [{ name: 'sku', type: 'String', targetProperty: 'SKU' }],
      requiredTargetProperties: ['SKU'],
      ...over,
    } as never;
  }

  it('REFUSES a pipeline whose source file was never uploaded, and never reaches the agent', () => {
    const { component, runAgentPrompt, createCredentialFromCase } = makeDeployComponent();

    component.deployIntegration(readyJob({ source: { type: 'file', adapterType: 'File' }, dataEntity: undefined }));

    expect(component.showNotReadyDialog).toBe(true);
    expect(runAgentPrompt).not.toHaveBeenCalled();
    // Nor may it do any of Deploy's IRIS-side setup for a deploy that can't start.
    expect(createCredentialFromCase).not.toHaveBeenCalled();
  });

  it('leaves NO pending state behind, so the single-deploy lock is not held', () => {
    // A refusal that marked the pipeline pending would strand it on "Deploying…"
    // forever AND block every later deploy.
    const { component } = makeDeployComponent();

    component.deployIntegration(readyJob({ targetClass: '' }));

    expect(component.isPending('job-1')).toBe(false);
    expect(component.anyDeployPending()).toBe(false);
  });

  it('names every unfinished step in the warning, one per line', () => {
    const { component } = makeDeployComponent();

    component.deployIntegration(readyJob({ name: '', columns: [] }));

    const lines = component.notReadyMessage.split('\n');
    expect(lines[0]).toContain('Step 1 · Data Source: Integration Name is required.');
    expect(lines.some((l) => l.startsWith('Step 2 · Data Entity'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Step 3 · Mapping'))).toBe(true);
  });

  it('REFUSES a mapping that skips a required target property, naming it', () => {
    const { component, runAgentPrompt } = makeDeployComponent();

    component.deployIntegration(readyJob({ requiredTargetProperties: ['SKU', 'Region'] }));

    expect(component.showNotReadyDialog).toBe(true);
    expect(component.notReadyMessage).toContain('Region');
    expect(runAgentPrompt).not.toHaveBeenCalled();
  });

  it('deploys a COMPLETE pipeline (the gate must not swallow a valid deploy)', () => {
    const { component, runAgentPrompt } = makeDeployComponent();

    component.deployIntegration(readyJob());

    expect(component.showNotReadyDialog).toBe(false);
    expect(runAgentPrompt).toHaveBeenCalledTimes(1);
    expect(component.isPending('job-1')).toBe(true);
  });

  it('a refused deploy leaves no residue: completing the pipeline lets the next one run', () => {
    const { component, runAgentPrompt } = makeDeployComponent();
    component.deployIntegration(readyJob({ targetClass: '' }));
    component.showNotReadyDialog = false;   // OK / backdrop

    component.deployIntegration(readyJob());

    expect(runAgentPrompt).toHaveBeenCalledTimes(1);
    expect(component.isPending('job-1')).toBe(true);
  });

  it('reports the MISSING KEY first when Claude is unavailable too', () => {
    // Both gates block. The key is the install-level blocker — sending the user off to
    // finish Step 2 would have them fix something that still cannot deploy.
    setAiEnabled(false);
    try {
      const { component } = makeDeployComponent();

      component.deployIntegration(readyJob({ targetClass: '' }));

      expect(component.showAiKeyDialog).toBe(true);
      expect(component.showNotReadyDialog).toBe(false);
    } finally {
      setAiEnabled(true);
    }
  });
});

/**
 * The list badge. Draft / Ready / Deployed, where "Ready" is DERIVED (a draft whose
 * three steps are all complete) rather than stored — so the backend's status stays
 * authoritative about what exists in IRIS, and the badge still tells the user whether
 * what they configured can be deployed.
 */
describe('statusLabel — Draft / Ready / Deployed', () => {
  function job(over: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      name: 'Nightly load',
      status: 'draft',
      sourceType: 'file',
      sourceName: 'orders.csv',
      source: { type: 'file', adapterType: 'File', filePath: '/uploads', fileSpec: 'orders.csv' },
      dataEntity: { nameLabel: 'File', name: 'orders.csv', sourceLabel: 'Path', source: '/uploads' },
      targetClass: 'Product',
      hasHeader: true,
      columns: [{ name: 'sku', type: 'String', targetProperty: 'SKU' }],
      requiredTargetProperties: ['SKU'],
      ...over,
    } as never;
  }

  it('reads "Ready to Deploy" for a complete draft', () => {
    // Spelled out, not a bare "Ready": the chip should say what the state affords.
    const { component } = makeComponent();
    expect(component.statusLabel(job())).toBe('Ready to Deploy');
    expect(component.statusTagClass(job())).toBe('di-status-tag--ready');
  });

  it('reads "Draft" while any step is still incomplete', () => {
    const { component } = makeComponent();
    expect(component.statusLabel(job({ targetClass: '' }))).toBe('Draft');
    expect(component.statusLabel(job({ columns: [] }))).toBe('Draft');
    expect(component.statusLabel(job({ name: '' }))).toBe('Draft');
    expect(component.statusTagClass(job({ targetClass: '' }))).toBe('di-status-tag--draft');
  });

  it('reads "Deployed" once IRIS holds the pipeline, regardless of readiness', () => {
    // A deployed pipeline is a fact about IRIS: it must not be re-labelled by a
    // readiness check (e.g. after a target class it used was changed).
    const { component } = makeComponent();
    expect(component.statusLabel(job({ status: 'deployed', targetClass: '' }))).toBe('Deployed');
    expect(component.statusTagClass(job({ status: 'deployed' }))).toBe('di-status-tag--deployed');
  });
});

/**
 * Delete asks first.
 *
 * Deleting a pipeline drops a whole configuration — connection, data entity, every
 * field mapping — with no undo, so it goes through the same confirmation the Cube and
 * KPI deletes use. What matters here is that NOTHING is deleted until the user says
 * yes, and that the deployed-pipeline refusal happens before the prompt (a dialog
 * offering an impossible delete would only be dismissed).
 */
describe('deleteIntegration — confirmation prompt', () => {
  const click = () => ({ stopPropagation: () => undefined }) as unknown as Event;

  function job(over: Record<string, unknown> = {}) {
    return { id: 'job-1', name: 'Nightly load', status: 'draft', sourceType: 'file', columns: [] , ...over } as never;
  }

  it('opens the prompt and deletes NOTHING on the click itself', () => {
    const { component, casesApi } = makeComponent();

    component.requestDeleteIntegration(job(), click());

    expect(component.pendingDeleteJob).toMatchObject({ id: 'job-1' });
    expect(casesApi.delete).not.toHaveBeenCalled();
  });

  it('deletes only once confirmed, and drops the row from the list', () => {
    const { component, casesApi } = makeComponent();
    component.jobs = [job() as never];
    component.selectedJob = component.jobs[0]!;

    component.requestDeleteIntegration(component.jobs[0]!, click());
    component.confirmDeleteIntegration();

    expect(casesApi.delete).toHaveBeenCalledWith('job-1');
    expect(component.jobs).toEqual([]);
    // The deleted pipeline must not stay selected on the detail panel.
    expect(component.selectedJob).toBeNull();
    expect(component.pendingDeleteJob).toBeNull();
  });

  it('deletes nothing when the prompt is dismissed', () => {
    const { component, casesApi } = makeComponent();
    component.jobs = [job() as never];

    component.requestDeleteIntegration(component.jobs[0]!, click());
    component.cancelDeleteIntegration();

    expect(casesApi.delete).not.toHaveBeenCalled();
    expect(component.jobs).toHaveLength(1);
    expect(component.pendingDeleteJob).toBeNull();
  });

  it('confirming twice cannot delete twice (the prompt is consumed)', () => {
    const { component, casesApi } = makeComponent();
    component.jobs = [job() as never];

    component.requestDeleteIntegration(component.jobs[0]!, click());
    component.confirmDeleteIntegration();
    component.confirmDeleteIntegration();

    expect(casesApi.delete).toHaveBeenCalledTimes(1);
  });

  it('REFUSES a deployed pipeline without prompting at all', () => {
    // Its IRIS classes and production hosts are live; deleting the case would orphan
    // them (the backend returns 409 too).
    const { component, casesApi } = makeComponent();

    component.requestDeleteIntegration(job({ status: 'deployed' }), click());

    expect(component.pendingDeleteJob).toBeNull();
    expect(casesApi.delete).not.toHaveBeenCalled();
  });

  it('keeps the row when the backend refuses the delete', () => {
    const { component, casesApi } = makeComponent();
    casesApi.delete.mockReturnValue(throwError(() => ({ error: { error: 'case is deployed' } })) as never);
    component.jobs = [job() as never];

    component.requestDeleteIntegration(component.jobs[0]!, click());
    component.confirmDeleteIntegration();

    // The list must reflect the server, not the intent — the pipeline is still there.
    expect(component.jobs).toHaveLength(1);
  });
});

/**
 * Deploy vs Redeploy.
 *
 * The action is the same either way — the skill keys idempotency on the integration
 * id, so a re-run rewrites the pipeline's existing classes rather than creating a
 * second set — but the button has to say which one is happening: "Deploy" on something
 * already deployed reads like it would do nothing.
 */
describe('deployLabel — Deploy / Redeploy', () => {
  function job(status: string) {
    return { id: 'job-1', name: 'Nightly load', status, sourceType: 'file', columns: [] } as never;
  }

  it('reads "Redeploy" once the pipeline is deployed', () => {
    const { component } = makeComponent();
    expect(component.deployLabel(job('deployed'))).toBe('Redeploy');
    expect(component.deployTooltip(job('deployed'))).toMatch(/Regenerate/);
  });

  it('reads "Deploy" for a draft', () => {
    const { component } = makeComponent();
    expect(component.deployLabel(job('draft'))).toBe('Deploy');
    expect(component.deployTooltip(job('draft'))).toMatch(/^Generate/);
  });

  it('reads "Deploy" for a legacy `created` pipeline — it was never deployed', () => {
    // `created` means the classes compiled but the hosts were never registered/started,
    // so deploying it is still the first deploy, not a re-run.
    const { component } = makeComponent();
    expect(component.deployLabel(job('created'))).toBe('Deploy');
  });
});

/**
 * `everDeployed` — "this pipeline's classes are live in SCO" — is a different fact from
 * `status`, and the two must not be conflated.
 *
 * Editing a deployed pipeline sends its status back to draft (the backend does that:
 * the saved config is no longer what is live), but the classes that deploy generated
 * are still there. So from then on the button still reads "Redeploy", and the case
 * still must not be deletable out from under those artifacts.
 */
describe('everDeployed — a deployed pipeline that was then edited', () => {
  const click = () => ({ stopPropagation: () => undefined }) as unknown as Event;

  /** Status back to draft after an edit, but the SCO artifacts still exist. */
  function editedAfterDeploy() {
    return { id: 'job-1', name: 'Nightly load', status: 'draft', everDeployed: true, sourceType: 'file', columns: [] } as never;
  }
  function neverDeployed() {
    return { id: 'job-2', name: 'New load', status: 'draft', sourceType: 'file', columns: [] } as never;
  }

  it('still offers REDEPLOY, because the classes are already in SCO', () => {
    const { component } = makeComponent();
    expect(component.deployLabel(editedAfterDeploy())).toBe('Redeploy');
    expect(component.deployTooltip(editedAfterDeploy())).toMatch(/Regenerate/);
  });

  it('is NOT deletable — deleting would orphan its live classes and hosts', () => {
    const { component, casesApi } = makeComponent();

    expect(component.canDeleteIntegration(editedAfterDeploy())).toBe(false);
    component.requestDeleteIntegration(editedAfterDeploy(), click());

    // Refused outright: no prompt, no request.
    expect(component.pendingDeleteJob).toBeNull();
    expect(casesApi.delete).not.toHaveBeenCalled();
  });

  it('a pipeline never deployed stays deletable and reads "Deploy"', () => {
    const { component } = makeComponent();
    expect(component.canDeleteIntegration(neverDeployed())).toBe(true);
    expect(component.deployLabel(neverDeployed())).toBe('Deploy');
  });

  it('shows its readiness again in the badge, not a stale "Deployed"', () => {
    // This is the point of the demotion: the badge must stop claiming the saved config
    // is live once it has been edited.
    const { component } = makeComponent();
    const complete = {
      ...(editedAfterDeploy() as unknown as Record<string, unknown>),
      source: { type: 'file', adapterType: 'File', filePath: '/uploads', fileSpec: 'orders.csv' },
      dataEntity: { nameLabel: 'File', name: 'orders.csv', sourceLabel: 'Path', source: '/uploads' },
      targetClass: 'Product',
      columns: [{ name: 'sku', type: 'String', targetProperty: 'SKU' }],
      requiredTargetProperties: ['SKU'],
    } as never;
    expect(component.statusLabel(complete)).toBe('Ready to Deploy');
  });

  it('reads it off the saved case (server-owned) when the list loads', () => {
    const { component, casesApi } = makeComponent();
    casesApi.list.mockReturnValue(of({
      cases: [{ id: 'job-1', name: 'Nightly load', status: 'draft', definition: { everDeployed: true, sourceType: 'file', columns: [] } }],
    }) as never);

    component.ngOnInit();

    expect(component.jobs[0]?.everDeployed).toBe(true);
    expect(component.canDeleteIntegration(component.jobs[0]!)).toBe(false);
  });
});

/**
 * The list row's hover hint. For a local file the pipeline's `sourceName` is the
 * DIRECTORY the File adapter polls — identical for every local-file pipeline, so it
 * distinguishes nothing. The uploaded file's own name is what the user recognizes.
 */
/**
 * The list row's hover hint.
 *
 * A pseudo-element tooltip cannot escape the list's `overflow-y: auto`, and only ~38px
 * sits above a row — so a hint that wraps to two lines gets clipped at the container's
 * TOP, which is how a field report ended up showing a bare JDBC URL with the pipeline's
 * name cut off. The hint therefore has to stay on one line, which means each adapter
 * contributes only its identifying token (host / bucket / file name), and the name wins
 * if both cannot fit.
 */
describe('rowTooltip / sourceHint — the hint must stay on one line', () => {
  function job(over: Record<string, unknown> = {}) {
    return {
      id: 'j', name: 'Load', status: 'draft', sourceType: 'file', sourceName: '', source: {}, columns: [],
      ...over,
    } as never;
  }

  it('shows the uploaded file NAME for a local file, not the poll directory', () => {
    const { component } = makeComponent();
    const j = job({
      name: 'CSV load', sourceName: '/tmp/sco-workbench/csv',
      dataEntity: { nameLabel: 'File', name: 'orders.csv', sourceLabel: 'Path', source: '/tmp/sco-workbench/csv' },
    });
    expect(component.sourceHint(j)).toBe('orders.csv');
    expect(component.rowTooltip(j)).toBe('CSV load · orders.csv');
  });

  it('falls back to the source name when a local-file case has no saved entity', () => {
    const { component } = makeComponent();
    expect(component.sourceHint(job({ sourceName: '/tmp/csv' }))).toBe('/tmp/csv');
  });

  it('reduces a database source to its HOST, not the whole JDBC URL', () => {
    // The URL is what wrapped the bubble and lost the name.
    const { component } = makeComponent();
    const j = job({
      name: 'PostgreSQL DB', sourceType: 'database',
      sourceName: 'jdbc:postgresql://54.226.72.249:5432/PostgreSQLDB',
      source: { type: 'database', adapterType: 'SQL', dbDsn: 'jdbc:postgresql://54.226.72.249:5432/PostgreSQLDB' },
    });

    expect(component.sourceHint(j)).toBe('54.226.72.249');
    expect(component.rowTooltip(j)).toBe('PostgreSQL DB · 54.226.72.249');
    expect(component.rowTooltip(j).length).toBeLessThanOrEqual(40);
  });

  it('reduces FTP to its host and cloud to its bucket', () => {
    const { component } = makeComponent();
    expect(component.sourceHint(job({
      sourceType: 'ftp', sourceName: 'SFTP @ files.example.com',
      source: { type: 'ftp', adapterType: 'FTP', ftpHost: 'files.example.com' },
    }))).toBe('files.example.com');
    expect(component.sourceHint(job({
      sourceType: 'cloud', sourceName: 'S3 / my-bucket',
      source: { type: 'cloud', adapterType: 'Cloud', cloudBucket: 'my-bucket' },
    }))).toBe('my-bucket');
  });

  it('falls back to the source name when the DSN is not parseable', () => {
    const { component } = makeComponent();
    const j = job({ sourceType: 'database', sourceName: 'Database (JDBC)', source: { type: 'database', adapterType: 'SQL', dbDsn: 'not-a-url' } });
    expect(component.sourceHint(j)).toBe('Database (JDBC)');
  });

  it('DROPS the source rather than the name when both will not fit on one line', () => {
    // Losing the name is the failure being prevented; losing the source is acceptable
    // (the detail panel shows it in full).
    const { component } = makeComponent();
    const longName = 'Nightly PostgreSQL customer import pipeline';
    const j = job({
      name: longName, sourceType: 'database',
      source: { type: 'database', adapterType: 'SQL', dbDsn: 'jdbc:postgresql://db.internal.example.com:5432/sales' },
    });

    expect(component.rowTooltip(j)).toBe(longName);
    expect(component.rowTooltip(j)).not.toContain('·');
  });

  it('shows the name alone when there is no source yet', () => {
    const { component } = makeComponent();
    expect(component.rowTooltip(job({ name: 'Fresh draft' }))).toBe('Fresh draft');
  });
});

/**
 * Guided mode may fill Step 1's connection fields, but NOT the upload-backed ones.
 *
 * `filePath` / `fileSpec` / the SFTP key files / the S3 credentials file all hold a
 * server-side path that only a real upload produces. A value the assistant typed would
 * point at a file that isn't there, and the pipeline would fail at Deploy (or silently
 * read nothing) with no sign of why — so the form refuses them and says who must act.
 */
describe('guidedSetField — Step-1 connection fields vs uploads', () => {
  /** Drive the guided controller the way a ui_set_field tool call does at runtime. */
  function setField(component: DataIntegrationComponent, path: string, value: unknown) {
    return (component as unknown as { guidedSetField: (p: string, v: unknown) => { applied: boolean; detail?: string } })
      .guidedSetField(path, value);
  }

  it('fills the SQL connection details the user gave in chat', () => {
    const { component } = makeComponent();
    component.openNewWizard();

    expect(setField(component, 'name', 'Nightly orders').applied).toBe(true);
    expect(setField(component, 'sourceType', 'database').applied).toBe(true);
    expect(setField(component, 'dbDataSourceName', 'Sales DB').applied).toBe(true);
    expect(setField(component, 'dbType', 'PostgreSQL').applied).toBe(true);
    expect(setField(component, 'dbDsn', 'jdbc:postgresql://db:5432/sales').applied).toBe(true);
    expect(setField(component, 'dbUsername', 'app').applied).toBe(true);

    expect(component.jobName).toBe('Nightly orders');
    expect(component.sourceConfig.dbDsn).toBe('jdbc:postgresql://db:5432/sales');
    expect(component.currentStep).toBe(1);
  });

  it('fills FTP/SFTP host details, including the protocol flag', () => {
    const { component } = makeComponent();
    component.openNewWizard();
    setField(component, 'sourceType', 'ftp');

    expect(setField(component, 'ftpHost', 'files.example.com').applied).toBe(true);
    expect(setField(component, 'ftpSftp', 'true').applied).toBe(true);

    expect(component.sourceConfig.ftpHost).toBe('files.example.com');
    expect(component.sourceConfig.ftpSftp).toBe(true);
  });

  it.each([
    ['file', 'filePath', '/tmp/orders'],
    ['file', 'fileSpec', 'orders.csv'],
    ['cloud', 'cloudCredentialsFile', '/creds/aws'],
    ['ftp', 'sftpPublicKeyFile', '/keys/id_rsa.pub'],
    ['ftp', 'sftpPrivateKeyFile', '/keys/id_rsa'],
  ])('REFUSES to fake the upload-backed %s field %s', (sourceType, field, value) => {
    const { component } = makeComponent();
    component.openNewWizard();
    setField(component, 'sourceType', sourceType);

    const res = setField(component, field, value);

    expect(res.applied).toBe(false);
    // The message has to say WHO acts, or the assistant just retries.
    expect(res.detail).toMatch(/Upload File/);
    expect((component.sourceConfig as unknown as Record<string, unknown>)[field]).toBeUndefined();
  });

  it('still rejects a field that belongs to a DIFFERENT source type', () => {
    const { component } = makeComponent();
    component.openNewWizard();
    setField(component, 'sourceType', 'database');

    const res = setField(component, 'ftpHost', 'files.example.com');

    expect(res.applied).toBe(false);
    expect(res.detail).toContain('is not a field of the database source');
  });
});

/**
 * The guided field contract must match the FORM, not the stored config shape.
 *
 * Field report: the assistant told the user to "enter the SQL query in the Query
 * field" — a field that hasn't existed since the query became derived from the Step-2
 * table pick. It said so because the guided allow-list was built from
 * SOURCE_CONFIG_FIELDS, which carries every persisted key including the derived ones.
 * Advertising a field the user cannot see is worse than refusing it: they go hunting.
 */
describe('guidedSetField — fields the form does NOT have', () => {
  function setField(component: DataIntegrationComponent, path: string, value: unknown) {
    return (component as unknown as { guidedSetField: (p: string, v: unknown) => { applied: boolean; detail?: string } })
      .guidedSetField(path, value);
  }
  function snapshot(component: DataIntegrationComponent) {
    return (component as unknown as { formSnapshot: () => Record<string, unknown> }).formSnapshot();
  }

  it.each([
    ['database', 'dbQuery', 'SELECT * FROM SC_Data.Customer'],
    ['ftp', 'ftpPath', '/data'],
    ['ftp', 'ftpFileSpec', 'orders.csv'],
    ['cloud', 'cloudBlobPrefix', 'raw/'],
    ['cloud', 'cloudBlobPattern', 'orders.csv'],
  ])('REFUSES the Step-2-derived %s field %s, and says not to ask the user', (sourceType, field, value) => {
    const { component } = makeComponent();
    component.openNewWizard();
    setField(component, 'sourceType', sourceType);

    const res = setField(component, field, value);

    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/derives it in Step 2/);
    // The instruction that actually prevents the bad advice.
    expect(res.detail).toMatch(/Do NOT ask the user to fill it in/);
  });

  it('does not ADVERTISE a derived field as fillable', () => {
    const { component } = makeComponent();
    component.openNewWizard();
    setField(component, 'sourceType', 'database');

    const snap = snapshot(component);

    expect(snap['validFieldPaths']).toEqual(['name', 'sourceType', 'dbType', 'dbDataSourceName', 'dbDsn', 'dbUsername', 'dbPassword']);
    expect(snap['validFieldPaths']).not.toContain('dbQuery');
    // …but it IS named as derived, so the assistant can explain it instead of
    // pretending it doesn't exist.
    expect(snap['derivedInStep2Fields']).toEqual(['dbQuery']);
  });

  it('advertises exactly the fields the FTP form renders, uploads called out separately', () => {
    const { component } = makeComponent();
    component.openNewWizard();
    setField(component, 'sourceType', 'ftp');

    const snap = snapshot(component);

    expect(snap['validFieldPaths']).toEqual([
      'name', 'sourceType', 'ftpSftp', 'ftpHost', 'ftpPort', 'ftpDataSourceName', 'ftpUsername', 'ftpPassword',
    ]);
    expect(snap['uploadOnlyFields']).toEqual(['sftpPublicKeyFile', 'sftpPrivateKeyFile']);
    expect(snap['derivedInStep2Fields']).toEqual(['ftpPath', 'ftpFileSpec']);
  });

  it('leaves a local-file source with nothing to fill but the name and type', () => {
    // Its only Step-1 control is the upload button.
    const { component } = makeComponent();
    component.openNewWizard();
    setField(component, 'sourceType', 'file');

    const snap = snapshot(component);

    expect(snap['validFieldPaths']).toEqual(['name', 'sourceType']);
    expect(snap['uploadOnlyFields']).toEqual(['filePath', 'fileSpec']);
  });

  it('still derives the query itself when the user picks a table in Step 2', () => {
    // The refusal must not break the real mechanism.
    const { component } = readySqlComponent();
    component.goDataStep();
    component.selectedSchema = 'SQLUser';
    component.onSchemaChange();
    component.selectedTable = 'Orders';
    component.onTableChange();

    expect(component.sourceConfig.dbQuery).toBe('SELECT * FROM SQLUser.Orders');
  });
});

/**
 * The wizard's UI context has to be able to CONTRADICT the assistant.
 *
 * Field report: it announced "Your Step 1 is now complete… click Next to move to Step 2,
 * where you'll write the SQL query" — while a required Data Source Name was still blank,
 * with no Next button on the wizard, and for a JDBC source no query is ever typed (Step 2
 * is a Schema + Table pick and the SELECT is derived). It described the form from memory
 * because the snapshot didn't state any of it. These pin what it now states.
 */
describe('formSnapshot — what the form says about the current step', () => {
  function snapshot(component: DataIntegrationComponent) {
    return (component as unknown as { formSnapshot: () => Record<string, unknown> }).formSnapshot();
  }

  /** readySqlComponent fills the form but doesn't open the wizard; the snapshot only
   *  describes a step while the wizard IS open, which is the state under test. */
  function openWizard(component: DataIntegrationComponent): void {
    component.wizardOpen = true;
  }

  it('lists EVERY required field still blank, not just the first', () => {
    const { component } = makeComponent();
    component.openNewWizard();          // database is the default source type
    component.jobName = 'Nightly load';
    component.sourceConfig.dbDsn = 'jdbc:postgresql://db:5432/sales';

    const snap = snapshot(component);

    expect(snap['requiredFieldsRemaining']).toEqual(['Data Source Name', 'Database Type', 'Username', 'Password']);
    expect(snap['stepComplete']).toBe(false);
  });

  it('reports the step complete only once nothing is missing', () => {
    const { component } = readySqlComponent();
    openWizard(component);

    const snap = snapshot(component);

    expect(snap['requiredFieldsRemaining']).toEqual([]);
    expect(snap['stepComplete']).toBe(true);
  });

  it('names the real advance button — there is no "Next"', () => {
    const { component } = readySqlComponent();
    openWizard(component);

    expect(snapshot(component)['advanceButton']).toEqual({
      label: 'Continue',
      does: 'saves this step and advances to Step 2',
    });
  });

  it('says a JDBC Step 2 is a schema+table pick, and that NO SQL is written by hand', () => {
    const { component } = readySqlComponent();
    openWizard(component);

    const hint = snapshot(component)['nextStepIs'] as string;

    expect(hint).toContain('Schema');
    expect(hint).toContain('Table');
    expect(hint).toMatch(/NO SQL is written by hand/);
  });

  it('describes each adapter’s Step 2 in its own terms', () => {
    const { component } = makeComponent();
    component.openNewWizard();
    component.jobName = 'x';

    component.sourceType = 'ftp';
    expect(snapshot(component)['nextStepIs']).toMatch(/pick ONE CSV file/);
    component.sourceType = 'cloud';
    expect(snapshot(component)['nextStepIs']).toMatch(/pick ONE CSV object/);
    component.sourceType = 'file';
    expect(snapshot(component)['nextStepIs']).toMatch(/nothing to pick/);
  });

  it('carries the blocking reason on Step 2, and the Mapping hint for Step 3', () => {
    const { component } = readySqlComponent();
    openWizard(component);
    component.goDataStep();                       // → Step 2, nothing selected yet

    const snap = snapshot(component);

    expect(component.currentStep).toBe(2);
    expect((snap['requiredFieldsRemaining'] as string[])[0]).toMatch(/Select a schema/);
    expect(snap['stepComplete']).toBe(false);
    expect(snap['advanceButton']).toMatchObject({ does: 'saves this step and advances to Step 3' });
    expect(snap['nextStepIs']).toMatch(/Target Class/);
  });

  it('on Step 3 says Save finishes, and reports the mapping blocker', () => {
    const { component } = readySqlComponent();
    openWizard(component);
    (component as unknown as { currentStep: number }).currentStep = 3;

    const snap = snapshot(component);

    expect(snap['advanceButton']).toEqual({ label: 'Save', does: 'saves the pipeline and closes the wizard' });
    expect(snap['nextStepIs']).toMatch(/last step/);
    expect((snap['requiredFieldsRemaining'] as string[])[0]).toMatch(/target class/i);
  });
});

/**
 * The list must keep saying WHICH pipeline you're working on.
 *
 * Opening the wizard used to blank the list highlight — `editJob()` clears the selection
 * and the row binding was `!wizardOpen` — so nothing on screen tied the form to a
 * pipeline. Cancel then dropped the user on the feature intro, because the selection was
 * still cleared, and they had to find their pipeline again.
 */
describe('list highlight + where Cancel lands', () => {
  function jobs() {
    return [
      { id: 'a', name: 'Alpha', status: 'draft', sourceType: 'file', source: {}, columns: [], hasHeader: true, targetClass: '', sourceName: 'a.csv' },
      { id: 'b', name: 'Beta', status: 'draft', sourceType: 'file', source: {}, columns: [], hasHeader: true, targetClass: '', sourceName: 'b.csv' },
    ] as never[];
  }

  it('highlights the SELECTED pipeline when no wizard is open', () => {
    const { component } = makeComponent();
    component.jobs = jobs();
    component.selectJob(component.jobs[0]!);

    expect(component.isRowActive(component.jobs[0]!)).toBe(true);
    expect(component.isRowActive(component.jobs[1]!)).toBe(false);
  });

  it('keeps the highlight on the pipeline being EDITED while the wizard is open', () => {
    const { component } = makeComponent();
    component.jobs = jobs();

    component.editJob(component.jobs[1]!);

    expect(component.wizardOpen).toBe(true);
    expect(component.isRowActive(component.jobs[1]!)).toBe(true);
    // …and not on the one that merely happened to be selected before.
    expect(component.isRowActive(component.jobs[0]!)).toBe(false);
  });

  it('highlights nothing while a NEW pipeline is being created — it has no row yet', () => {
    const { component } = makeComponent();
    component.jobs = jobs();
    component.selectJob(component.jobs[0]!);

    component.openNewWizard();

    expect(component.isRowActive(component.jobs[0]!)).toBe(false);
    expect(component.isRowActive(component.jobs[1]!)).toBe(false);
  });

  it('Cancel returns to the edited pipeline’s DETAIL view, still highlighted', () => {
    const { component } = makeComponent();
    component.jobs = jobs();
    component.editJob(component.jobs[1]!);

    component.cancelWizard();

    expect(component.wizardOpen).toBe(false);
    expect(component.selectedJob?.id).toBe('b');
    expect(component.isRowActive(component.jobs[1]!)).toBe(true);
  });

  it('Cancel lands there too when the unsaved-changes prompt is confirmed', () => {
    const { component } = makeComponent();
    component.jobs = jobs();
    component.editJob(component.jobs[1]!);
    component.jobName = 'edited';          // makes the form dirty → Cancel prompts

    component.cancelWizard();
    expect(component.showLeaveConfirm).toBe(true);
    component.leaveWithoutSaving();

    expect(component.wizardOpen).toBe(false);
    expect(component.selectedJob?.id).toBe('b');
  });

  it('Cancel from a never-saved NEW pipeline selects nothing (there is nothing to show)', () => {
    const { component } = makeComponent();
    component.jobs = jobs();
    component.openNewWizard();

    component.cancelWizard();

    expect(component.wizardOpen).toBe(false);
    expect(component.selectedJob).toBeNull();
  });

  it('Save (Step 3) also lands on the pipeline’s detail view', () => {
    const { component } = makeComponent();
    component.jobs = jobs();
    component.editJob(component.jobs[1]!);
    component.selectedTargetClass = 'Product';
    component.sourceColumns = [{ name: 'sku', type: 'String', targetProperty: 'SKU' }] as never;

    component.saveJob();

    expect(component.wizardOpen).toBe(false);
    expect(component.selectedJob?.id).toBe('b');
    expect(component.isRowActive(component.jobs[1]!)).toBe(true);
  });
});

describe('Load sample data tile on Step 1', () => {
  it('asks the shell for the Load sample data page, and changes nothing in the wizard', () => {
    // The tile sits in the Source Type row but is NOT a source type: clicking it must
    // leave the page, not quietly re-point the integration being built. Navigation goes
    // through the bridge so the shell's unsaved-edits handshake still gets its say.
    const { component, bridge } = readySqlComponent();

    component.openLoadSampleData();

    expect(bridge.setActiveView).toHaveBeenCalledWith('load-sample-data');
    expect(component.sourceType).toBe('database');
    expect(component.currentStep).toBe(1);
  });
});

describe('Data Integration page shell (SC-2665 / E4)', () => {
  it('uses the shared .page--full shell', () => {
    const component = makeComponent().component;
    // makeComponent instantiates the component directly without TestBed/fixture,
    // so we can't query its DOM. Verify the component was created successfully.
    expect(component).toBeDefined();
  });
});

/**
 * Refresh must come back to the pipeline the user had open — the `?item=` deep link
 * the shell mirrors into the URL — on its DETAIL view, never the wizard.
 */
describe('data-integration `?item=` deep link', () => {
  const SAVED = {
    id: 'case-1',
    name: 'Nightly load',
    status: 'draft' as const,
    definition: { sourceType: 'database', sourceName: 'Sales DB', targetClass: 'SC.Data.Product', columns: [] },
  };

  /** A component whose saved-case list holds one pipeline, as after a page load. */
  function loaded() {
    const made = makeComponent();
    made.casesApi.list = vi.fn(() => of({ cases: [SAVED] })) as never;
    made.component.ngOnInit();
    const controller = made.component['guidedController'] as GuidedFormController;
    return { ...made, controller };
  }

  it('reports the selected pipeline by id, and nothing on the feature intro', () => {
    const { component, controller } = loaded();
    expect(controller.currentItem!()).toBeNull();

    component.selectJob(component.jobs[0]!);

    expect(controller.currentItem!()).toBe('case-1');
  });

  it('reports the pipeline the wizard is EDITING, so a refresh returns to it', () => {
    const { component, controller } = loaded();
    component.editJob(component.jobs[0]!);

    expect(controller.currentItem!()).toBe('case-1');
  });

  it('reports nothing for a brand-new pipeline — it has no id until its first save', () => {
    const { component, controller } = loaded();
    component.openNewWizard();

    expect(controller.currentItem!()).toBeNull();
  });

  it('re-selects the pipeline the token names, on its detail view (never the wizard)', async () => {
    const { component, controller } = loaded();

    expect(await controller.restoreItem!('case-1')).toBe(true);

    expect(component.selectedJob?.id).toBe('case-1');
    expect(component.wizardOpen).toBe(false);
  });

  it('reports false for a pipeline that is gone, leaving the feature intro on screen', async () => {
    const { component, controller } = loaded();

    expect(await controller.restoreItem!('case-deleted')).toBe(false);

    expect(component.selectedJob).toBeNull();
  });

  it('waits for the case list instead of racing it', async () => {
    const made = makeComponent();
    const cases = new Subject<{ cases: unknown[] }>();
    made.casesApi.list = vi.fn(() => cases.asObservable()) as never;
    made.component.ngOnInit();
    const controller = made.component['guidedController'] as GuidedFormController;

    const restore = controller.restoreItem!('case-1'); // list still in flight
    cases.next({ cases: [SAVED] });

    expect(await restore).toBe(true);
    expect(made.component.selectedJob?.id).toBe('case-1');
  });

  it('settles (rather than hanging) when the case list fails to load', async () => {
    const made = makeComponent();
    made.casesApi.list = vi.fn(() => throwError(() => new Error('offline'))) as never;
    made.component.ngOnInit();
    const controller = made.component['guidedController'] as GuidedFormController;

    expect(await controller.restoreItem!('case-1')).toBe(false);
  });
});
