import type { IntegrationJob, SourceConfig, SourceType } from './data-integration.model';
import {
  hasPolledEntity,
  isJobReady,
  jobReadinessGaps,
  missingStep1Field,
  readinessWarningMessage,
  unmappedRequiredProperties,
} from './job-readiness';

/**
 * The rules that decide whether a pipeline may be deployed.
 *
 * These are what stands between a half-filled wizard and an agent turn that fails as
 * an ObjectScript compile error — so the negative cases matter more than the positive
 * one: each incomplete shape must be reported against the STEP that owns the fix, and
 * a job must never be waved through on a field that is present but blank.
 */

/** A complete local-file pipeline; each test breaks exactly one thing about it. */
function readyFileJob(over: Partial<IntegrationJob> = {}): IntegrationJob {
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
  };
}

/** A complete SQL pipeline — the adapter with the most required Step-1 fields. */
function readySqlJob(over: Partial<IntegrationJob> = {}): IntegrationJob {
  return readyFileJob({
    sourceType: 'database',
    source: {
      type: 'database', adapterType: 'SQL',
      dbDataSourceName: 'Sales DB', dbType: 'IRIS', dbDsn: 'jdbc:IRIS://h:1972/NS',
      dbUsername: 'app', dbPassword: 'pw', dbQuery: 'SELECT sku FROM SC_Data.Product',
    },
    dataEntity: { nameLabel: 'Table', name: 'Product', sourceLabel: 'Schema', source: 'SC_Data' },
    ...over,
  });
}

/** Convenience: the steps a job is incomplete on. */
function gapSteps(job: IntegrationJob): number[] {
  return jobReadinessGaps(job).map((g) => g.step);
}

describe('isJobReady — a complete pipeline', () => {
  it('accepts a fully configured local-file pipeline', () => {
    expect(jobReadinessGaps(readyFileJob())).toEqual([]);
    expect(isJobReady(readyFileJob())).toBe(true);
  });

  it('accepts a fully configured SQL pipeline', () => {
    expect(isJobReady(readySqlJob())).toBe(true);
  });

  it('accepts a job with no REQUIRED target properties, as long as something is mapped', () => {
    expect(isJobReady(readyFileJob({ requiredTargetProperties: [] }))).toBe(true);
  });
});

describe('jobReadinessGaps — Step 1 (data source)', () => {
  it('reports the missing Integration Name against Step 1', () => {
    const gaps = jobReadinessGaps(readyFileJob({ name: '' }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ step: 1, stepLabel: 'Data Source' });
    expect(gaps[0]!.message).toBe('Integration Name is required.');
  });

  it('treats a whitespace-only name as missing (not as filled in)', () => {
    expect(gapSteps(readyFileJob({ name: '   ' }))).toEqual([1]);
  });

  it.each([
    ['dbDataSourceName', 'Data Source Name'],
    ['dbType', 'Database Type'],
    ['dbDsn', 'DSN (JDBC URL)'],
    ['dbUsername', 'Username'],
    ['dbPassword', 'Password'],
  ])('names the missing SQL field %s as "%s"', (field, label) => {
    const source = { ...readySqlJob().source, [field]: '' } as SourceConfig;
    const gaps = jobReadinessGaps(readySqlJob({ source }));
    expect(gaps[0]).toMatchObject({ step: 1 });
    expect(gaps[0]!.message).toBe(`${label} is required.`);
  });

  it('accepts a SQL password made only of spaces (legal), unlike an empty one', () => {
    const spaces = { ...readySqlJob().source, dbPassword: '  ' } as SourceConfig;
    expect(isJobReady(readySqlJob({ source: spaces }))).toBe(true);
  });

  it('requires BOTH SFTP key files, but neither for plain FTP', () => {
    const ftpSource = {
      type: 'ftp', adapterType: 'FTP',
      ftpDataSourceName: 'Drop', ftpHost: 'files.example.com', ftpUsername: 'app',
      ftpFileSpec: 'orders.csv',
    } as SourceConfig;
    const ftp = readyFileJob({ sourceType: 'ftp', source: ftpSource,
      dataEntity: { nameLabel: 'File', name: 'orders.csv', sourceLabel: 'Path', source: '/d/orders.csv' } });
    // Plain FTP with no password/keys is a valid anonymous login.
    expect(isJobReady(ftp)).toBe(true);

    const sftp = { ...ftp, source: { ...ftpSource, ftpSftp: true } as SourceConfig };
    expect(missingStep1Field(sftp.name, sftp.sourceType, sftp.source)).toBe('SFTP Public Key File');
    const withPublic = { ...sftp, source: { ...sftp.source, sftpPublicKeyFile: '/k/pub' } as SourceConfig };
    expect(missingStep1Field(withPublic.name, withPublic.sourceType, withPublic.source)).toBe('SFTP Private Key File');
  });

  it('requires the cloud credentials file, bucket and region', () => {
    const cloud = {
      type: 'cloud', adapterType: 'Cloud',
      cloudBucket: 'b', cloudRegion: 'us-east-1', cloudBlobPattern: 'orders.csv',
    } as SourceConfig;
    expect(missingStep1Field('n', 'cloud', cloud)).toBe('AWS-S3 Credentials File');
    expect(missingStep1Field('n', 'cloud', { ...cloud, cloudRegion: '' } as SourceConfig)).toBe('Storage Region');
    expect(missingStep1Field('n', 'cloud', { ...cloud, cloudBucket: '' } as SourceConfig)).toBe('Bucket Name');
  });
});

describe('jobReadinessGaps — Step 2 (data entity)', () => {
  it('reports a job whose data entity was never picked', () => {
    // A SQL job with no derived query: nothing was selected in Step 2, so the
    // deployed service would have no SELECT to poll with.
    const source = { ...readySqlJob().source, dbQuery: '' } as SourceConfig;
    const gaps = jobReadinessGaps(readySqlJob({ source }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ step: 2, stepLabel: 'Data Entity' });
    expect(gaps[0]!.message).toMatch(/Select the data entity/);
  });

  it('reports a missing entity even when the summary label survived', () => {
    // dataEntity is only a display summary — the polled field is what actually
    // deploys, so a job carrying one without the other must NOT pass.
    const source = { ...readySqlJob().source, dbQuery: '' } as SourceConfig;
    const job = readySqlJob({ source });
    expect(job.dataEntity).toBeDefined();
    expect(gapSteps(job)).toEqual([2]);
  });

  it('blames STEP 1 (not Step 2) for a local file that was never uploaded', () => {
    // The Local File adapter picks its file in Step 1 and Step 2 only previews it, so
    // "select a data entity" would send the user to a step with nothing to click.
    const source = { type: 'file', adapterType: 'File' } as SourceConfig;
    const gaps = jobReadinessGaps(readyFileJob({ source, dataEntity: undefined }));
    expect(gaps.map((g) => g.step)).toEqual([1]);
    expect(gaps[0]!.message).toBe('File is required.');
  });

  it('reports an entity that yielded no columns', () => {
    const gaps = jobReadinessGaps(readyFileJob({ columns: [] }));
    // No columns is a Step-2 problem AND leaves Step 3 with nothing mapped.
    expect(gaps.map((g) => g.step)).toEqual([2, 3]);
    expect(gaps[0]!.message).toMatch(/no source columns/);
  });

  it.each([
    ['database', { type: 'database', adapterType: 'SQL', dbQuery: 'SELECT 1' }],
    ['ftp', { type: 'ftp', adapterType: 'FTP', ftpFileSpec: 'a.csv' }],
    ['cloud', { type: 'cloud', adapterType: 'Cloud', cloudBlobPattern: 'a.csv' }],
    ['file', { type: 'file', adapterType: 'File', filePath: '/u' }],
  ])('hasPolledEntity reads the %s adapter\'s own polled field', (type, config) => {
    expect(hasPolledEntity(type as SourceType, config as SourceConfig)).toBe(true);
  });

  it('hasPolledEntity rejects a blank polled field', () => {
    expect(hasPolledEntity('ftp', { type: 'ftp', adapterType: 'FTP', ftpFileSpec: '  ' } as SourceConfig)).toBe(false);
  });
});

describe('jobReadinessGaps — Step 3 (mapping)', () => {
  it('reports a missing target class', () => {
    const gaps = jobReadinessGaps(readyFileJob({ targetClass: '' }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ step: 3, stepLabel: 'Mapping' });
    expect(gaps[0]!.message).toBe('Select a target class.');
  });

  it('treats a whitespace-only target class as unset', () => {
    expect(gapSteps(readyFileJob({ targetClass: '  ' }))).toEqual([3]);
  });

  it('reports columns that exist but map to nothing', () => {
    const gaps = jobReadinessGaps(readyFileJob({ columns: [{ name: 'sku', type: 'String', targetProperty: '' }] }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.message).toMatch(/Map at least one source field/);
  });

  it('does not count a whitespace-only target property as a mapping', () => {
    const gaps = jobReadinessGaps(readyFileJob({ columns: [{ name: 'sku', type: 'String', targetProperty: ' ' }] }));
    expect(gaps[0]!.message).toMatch(/Map at least one source field/);
  });

  it('names the required target properties left unmapped', () => {
    const gaps = jobReadinessGaps(readyFileJob({ requiredTargetProperties: ['SKU', 'Region', 'Qty'] }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.message).toBe('Map every required target property. Unmapped: Region, Qty.');
  });

  it('lets a legacy case (saved before required properties were recorded) through', () => {
    // Those cases were validated by the same rule at Save; holding them back for a
    // list we can no longer see would strand pipelines that are actually complete.
    const legacy = readyFileJob();
    delete legacy.requiredTargetProperties;
    expect(isJobReady(legacy)).toBe(true);
  });

  it('unmappedRequiredProperties ignores extra mappings and matches exactly', () => {
    const columns = [
      { name: 'sku', type: 'String', targetProperty: 'SKU' },
      { name: 'other', type: 'String', targetProperty: 'Extra' },
    ];
    expect(unmappedRequiredProperties(['SKU'], columns)).toEqual([]);
    // Case-sensitive on purpose: these are IRIS property names, not free text.
    expect(unmappedRequiredProperties(['sku'], columns)).toEqual(['sku']);
  });
});

describe('jobReadinessGaps — a job abandoned early', () => {
  it('reports EVERY unfinished step at once, in wizard order', () => {
    const bare: IntegrationJob = {
      id: 'job-2',
      name: '',
      status: 'draft',
      sourceType: 'file',
      sourceName: '',
      source: { type: 'file', adapterType: 'File' },
      targetClass: '',
      hasHeader: true,
      columns: [],
    };
    const gaps = jobReadinessGaps(bare);
    // One per step: sending the user back one step at a time would hide how much is
    // actually left to do.
    expect(gaps.map((g) => g.step)).toEqual([1, 2, 3]);
    expect(isJobReady(bare)).toBe(false);
  });

  it('renders the gaps as one line per step for the warning dialog', () => {
    const message = readinessWarningMessage(jobReadinessGaps(readyFileJob({ name: '', targetClass: '' })));
    expect(message.split('\n')).toEqual([
      'Step 1 · Data Source: Integration Name is required.',
      'Step 3 · Mapping: Select a target class.',
    ]);
  });
});
