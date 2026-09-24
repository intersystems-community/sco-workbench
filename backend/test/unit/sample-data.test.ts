// backend/test/unit/sample-data.test.ts
//
// The sample-data endpoints behind the "Load sample data" page: the folder scan
// (util/sample-data.ts), the listing route, and the LOAD route that adds one set's
// CSVs to the SCO data model's own SC_Data tables. Everything runs against REAL temp
// directories — much of the job is filesystem edge cases (dotfiles, plain files,
// symlinks, a missing directory, a name trying to escape the set), and a mocked fs
// would prove none of them. IRIS is the fake in `helpers/fake-sc-data-iris.ts`; name
// resolution, load ordering and staging live in sc-data-mapping/sc-data-load-ops and have
// their own tests, and the real SQL is covered by the live integration test.
//
// Note what the fake reports by default: the installed SC_Data tables, and NO foreign keys
// (see that helper's comment). So a test about load ORDER has to declare the keys it wants
// ordered by — there is no list of tables here to fall back on any more.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSampleDataFolders,
  isSampleDataSetName,
  listSampleDataCsvFiles,
  readSampleDataCsv,
  readSampleDataIntro,
  resolveSampleDataDir,
  DEFAULT_SAMPLE_DATA_DIR,
} from '../../src/util/sample-data.js';
import { createSampleDataRouter } from '../../src/server/sample-data-routes.js';
import { errorEnvelope, apiNotFound } from '../../src/server/error-middleware.js';
import { IrisAuthError, IrisTimeoutError, IrisUnreachableError } from '../../src/iris/iris-error.js';
import type { ScDataLoadDeps } from '../../src/iris/sc-data-load-ops.js';
import { createFakeScDataIris } from './helpers/fake-sc-data-iris.js';
import type { Env } from '../../src/config/env.js';

/** A throwaway directory per test, cleaned up in afterEach. */
const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sample-data-'));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

describe('listSampleDataFolders', () => {
  it('returns only the SUBFOLDER names, sorted, ignoring files beside them', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Test2'));
    mkdirSync(join(dir, 'Test1'));
    // A loose file next to the sets is not a data set.
    writeFileSync(join(dir, 'README.txt'), 'notes');
    writeFileSync(join(dir, 'customers.csv'), 'id,name\n');

    expect(await listSampleDataFolders(dir)).toEqual(['Test1', 'Test2']);
  });

  it('skips dot-entries — macOS .DS_Store never reaches the dropdown', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Test1'));
    writeFileSync(join(dir, '.DS_Store'), 'binary junk');
    // A hidden DIRECTORY is skipped too: dot-prefixed means "not for the user".
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, '.hidden-set'));

    expect(await listSampleDataFolders(dir)).toEqual(['Test1']);
  });

  it('counts an EMPTY folder as a data set (the page shows it; the CSVs are a later concern)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Test1'));
    writeFileSync(join(dir, 'Test1', 'customers.csv'), 'id\n');
    mkdirSync(join(dir, 'Test2')); // deliberately empty, like the real SampleData/Test2

    expect(await listSampleDataFolders(dir)).toEqual(['Test1', 'Test2']);
  });

  it('lists names only, not paths, and does not descend into a set', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Test1', 'nested'), { recursive: true });

    const folders = await listSampleDataFolders(dir);
    expect(folders).toEqual(['Test1']);
    expect(folders[0]).not.toContain('/');
    expect(folders).not.toContain('nested');
  });

  it('includes a symlink that points at a directory, and drops a dangling one', async () => {
    const dir = tempDir();
    const real = tempDir();
    mkdirSync(join(real, 'Shared'));
    symlinkSync(join(real, 'Shared'), join(dir, 'LinkedSet'));
    symlinkSync(join(real, 'gone'), join(dir, 'BrokenSet')); // target never existed
    // A symlink to a FILE is not a folder either.
    writeFileSync(join(real, 'a.csv'), 'x\n');
    symlinkSync(join(real, 'a.csv'), join(dir, 'LinkedFile'));

    expect(await listSampleDataFolders(dir)).toEqual(['LinkedSet']);
  });

  it('is EMPTY, not an error, when the directory does not exist', async () => {
    // SampleData/ is not tracked in git, so a fresh clone legitimately has none —
    // the page must say "no sample data", not show a failure.
    expect(await listSampleDataFolders(join(tempDir(), 'no-such-dir'))).toEqual([]);
  });

  it('is EMPTY when the configured path is a FILE, not a directory', async () => {
    const dir = tempDir();
    const notADir = join(dir, 'SampleData');
    writeFileSync(notADir, 'oops');

    expect(await listSampleDataFolders(notADir)).toEqual([]);
  });

  it('returns [] for an empty directory', async () => {
    expect(await listSampleDataFolders(tempDir())).toEqual([]);
  });

  it('handles names with spaces, punctuation and non-ASCII characters', async () => {
    const dir = tempDir();
    for (const name of ['Zebra', 'apple pie', 'Éclair', 'set-2 (copy)']) mkdirSync(join(dir, name));

    // Locale-aware sort: 'apple pie' does NOT sort after every capitalized name the
    // way a raw code-unit comparison would put it.
    expect(await listSampleDataFolders(dir)).toEqual(['apple pie', 'Éclair', 'set-2 (copy)', 'Zebra']);
  });

  it('PROPAGATES a real failure (an unreadable directory) instead of pretending it is empty', async () => {
    const dir = tempDir();
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    mkdirSync(join(locked, 'Test1'));
    chmodSync(locked, 0o000);
    try {
      // Root ignores the mode bits, so only assert when the OS actually refuses.
      let threw = false;
      await listSampleDataFolders(locked).catch(() => (threw = true));
      if (process.getuid?.() !== 0) expect(threw).toBe(true);
    } finally {
      chmodSync(locked, 0o755); // so the afterEach cleanup can remove it
    }
  });
});

describe('isSampleDataSetName', () => {
  it('accepts a plain one-segment folder name', () => {
    for (const name of ['Test1', 'apple pie', 'Éclair', 'set-2 (copy)', 'a']) {
      expect(isSampleDataSetName(name)).toBe(true);
    }
  });

  it('REJECTS anything that could leave the SampleData directory', () => {
    // The name arrives from the browser, so this is the traversal guard.
    for (const name of [
      '..',
      '.',
      '../..',
      '../../etc/passwd',
      'Test1/../../etc',
      'Test1/nested',
      '/etc/passwd',
      'C:\\Windows',
      'Test1\\nested',
      'Test1\u0000.csv', // NUL poisoning — truncates the path in some syscalls
      '',
      '   ',
      ' Test1', // untrimmed: it can never equal a listed name anyway
      'Test1 ',
      '.hidden', // dot-entries are not listed as sets either
    ]) {
      expect(isSampleDataSetName(name), name).toBe(false);
    }
  });
});

describe('listSampleDataCsvFiles', () => {
  it('returns only CSV FILES, sorted, whatever the case of the extension', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'products.csv'), 'a\n');
    writeFileSync(join(dir, 'Orders.CSV'), 'a\n');
    writeFileSync(join(dir, 'README.txt'), 'notes'); // not a table
    writeFileSync(join(dir, 'data.csv.bak'), 'a\n'); // a backup is not a CSV
    mkdirSync(join(dir, 'nested.csv')); // a DIRECTORY that looks like one

    expect(await listSampleDataCsvFiles(dir)).toEqual(['Orders.CSV', 'products.csv']);
  });

  it('skips dot-files and does not descend into subfolders', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'products.csv'), 'a\n');
    writeFileSync(join(dir, '._products.csv'), 'macOS resource fork');
    writeFileSync(join(dir, '.DS_Store'), 'junk');
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'archive', 'old.csv'), 'a\n');

    expect(await listSampleDataCsvFiles(dir)).toEqual(['products.csv']);
  });

  it('follows a symlink to a file and drops a dangling one', async () => {
    const dir = tempDir();
    const real = tempDir();
    writeFileSync(join(real, 'shared.csv'), 'a\n');
    symlinkSync(join(real, 'shared.csv'), join(dir, 'linked.csv'));
    symlinkSync(join(real, 'gone.csv'), join(dir, 'broken.csv'));

    expect(await listSampleDataCsvFiles(dir)).toEqual(['linked.csv']);
  });

  it('is EMPTY, not an error, when the set directory is gone or is a file', async () => {
    // The set can be deleted between listing it and loading it.
    const dir = tempDir();
    expect(await listSampleDataCsvFiles(join(dir, 'no-such-set'))).toEqual([]);
    const file = join(dir, 'notADir');
    writeFileSync(file, 'x');
    expect(await listSampleDataCsvFiles(file)).toEqual([]);
  });
});

describe('readSampleDataCsv', () => {
  it('reads the file as UTF-8 text, byte for byte', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.csv'), 'id,name\r\n1,Éclair\r\n');
    expect(await readSampleDataCsv(dir, 'a.csv')).toBe('id,name\r\n1,Éclair\r\n');
  });

  it('REFUSES a file name that is not a single segment, even for a trusted caller', async () => {
    const dir = tempDir();
    for (const file of ['../secret.csv', 'nested/a.csv', '..', 'a\u0000.csv']) {
      await expect(readSampleDataCsv(dir, file)).rejects.toThrow(/not a file name inside the data set/);
    }
  });
});

describe('readSampleDataIntro', () => {
  it('reads the set\'s own description, trimmed', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'intro.txt'), '\n  This set is the demo generator output.  \n\n');
    expect(await readSampleDataIntro(dir)).toBe('This set is the demo generator output.');
  });

  it('keeps the author\'s line and paragraph breaks, but not a run of blank lines', async () => {
    // The text is rendered as written (the page keeps newlines), so a deliberate break
    // has to survive — while ten blank lines pushing the table list off the page must not.
    const dir = tempDir();
    writeFileSync(
      join(dir, 'intro.txt'),
      'Healthcare demo.\r\n17 files.\r\n\r\n\r\n\r\nGenerated 2026-09-01.\r\n',
    );
    expect(await readSampleDataIntro(dir)).toBe(
      'Healthcare demo.\n17 files.\n\nGenerated 2026-09-01.',
    );
  });

  it('answers "" for a set with no intro, and for a BLANK one', async () => {
    // Most of what this guards: a set that simply has no description, and one whose file
    // is there but says nothing — both mean "there is nothing to show", not a failure.
    const dir = tempDir();
    expect(await readSampleDataIntro(dir)).toBe('');
    writeFileSync(join(dir, 'intro.txt'), '\n  \t\n');
    expect(await readSampleDataIntro(dir)).toBe('');
  });

  it('reads an intro named in another case, which only Linux would otherwise miss', async () => {
    // macOS's filesystem is case-insensitive: a set authored with `Intro.txt` works for
    // whoever added it and would show nothing once the folder is mounted in a container.
    const dir = tempDir();
    writeFileSync(join(dir, 'Intro.TXT'), 'Named in another case.');
    expect(await readSampleDataIntro(dir)).toBe('Named in another case.');
  });

  it('CAPS a runaway intro instead of letting it bury the table list', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'intro.txt'), 'a'.repeat(5_000));
    const intro = await readSampleDataIntro(dir);
    expect(intro).toHaveLength(2_001); // 2,000 characters plus the ellipsis
    expect(intro.endsWith('…')).toBe(true);
  });

  it('never throws — an unreadable intro costs the description, not the preview', async () => {
    // A directory named intro.txt, a missing set, and a file where the set should be: the
    // tables are the answer the page needs, and none of these may take it away.
    const dir = tempDir();
    mkdirSync(join(dir, 'intro.txt'));
    expect(await readSampleDataIntro(dir)).toBe('');
    expect(await readSampleDataIntro(join(dir, 'gone'))).toBe('');
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(await readSampleDataIntro(file)).toBe('');
  });

  it('is not offered to the loader: intro.txt is not a CSV', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'intro.txt'), 'Not data.');
    writeFileSync(join(dir, 'carriers.csv'), 'ID\nCAR-1\n');
    expect(await listSampleDataCsvFiles(dir)).toEqual(['carriers.csv']);
  });
});

describe('resolveSampleDataDir', () => {
  it('falls back to the repo SampleData folder when SAMPLE_DATA_DIR is unset or blank', () => {
    for (const value of [undefined, '', '   '] as (string | undefined)[]) {
      const env = { SAMPLE_DATA_DIR: value } as unknown as Env;
      expect(resolveSampleDataDir(env)).toBe(DEFAULT_SAMPLE_DATA_DIR);
    }
    // The default sits beside the backend package, not inside it.
    expect(DEFAULT_SAMPLE_DATA_DIR.endsWith('/SampleData')).toBe(true);
    expect(DEFAULT_SAMPLE_DATA_DIR).not.toContain('/backend/');
  });

  it('uses a configured directory, absolutized and trimmed', () => {
    const dir = tempDir();
    expect(resolveSampleDataDir({ SAMPLE_DATA_DIR: `  ${dir}  ` } as unknown as Env)).toBe(dir);
    // A relative override resolves against the process cwd rather than staying relative.
    expect(resolveSampleDataDir({ SAMPLE_DATA_DIR: 'sets' } as unknown as Env)).toBe(join(process.cwd(), 'sets'));
  });
});

// ---------------------------------------------------------------- route ------

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function startApp(sampleDataDir: string, iris: ScDataLoadDeps = createFakeScDataIris().deps): string {
  const app: Express = express();
  app.use(express.json({ limit: '2mb' })); // as in app.ts — POST /load reads a JSON body
  app.use('/api/sample-data', createSampleDataRouter(sampleDataDir, iris));
  // Same tail as the real app, so an unmatched /api path gets the JSON envelope
  // rather than Express' HTML page.
  app.use(apiNotFound());
  app.use(errorEnvelope(false));
  server = app.listen(0);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as { folders?: string[]; error?: string; code?: string } };
}

/** One CSV's entry in a load report. */
interface TableResult {
  file: string;
  table: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  columns?: number;
  rows?: number;
  skippedRows?: number;
  orphanRows?: number;
  orphanReason?: string;
  ignoredHeaders?: string[];
  error?: string;
}
interface LoadBody {
  folder?: string;
  schema?: string;
  tables?: TableResult[];
  totalRows?: number;
  totalSkippedRows?: number;
  totalOrphanRows?: number;
  totalIgnoredHeaders?: number;
  aborted?: string;
  ok?: boolean;
  error?: string;
  code?: string;
}

/** POST /load with a raw body, so a non-object and a bad type are testable too. */
async function postLoad(base: string, body: unknown) {
  const res = await fetch(`${base}/api/sample-data/load`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as LoadBody };
}

let populated: string;
beforeAll(() => {
  populated = mkdtempSync(join(tmpdir(), 'sample-data-route-'));
  mkdirSync(join(populated, 'Test2'));
  mkdirSync(join(populated, 'Test1'));
  writeFileSync(join(populated, '.DS_Store'), 'junk');
});
afterAll(() => rmSync(populated, { recursive: true, force: true }));

describe('GET /api/sample-data/folders', () => {
  it('answers { folders } with the data-set names in sorted order', async () => {
    const { status, body } = await get(startApp(populated), '/api/sample-data/folders');
    expect(status).toBe(200);
    expect(body).toEqual({ folders: ['Test1', 'Test2'] });
  });

  it('answers 200 with an EMPTY list when the directory is absent', async () => {
    const { status, body } = await get(startApp(join(tmpdir(), 'sco-no-sample-data-here')), '/api/sample-data/folders');
    expect(status).toBe(200);
    expect(body).toEqual({ folders: [] });
  });

  it('404s (envelope shape) for a path the router does not own', async () => {
    // The dropdown lists names only — there is deliberately no per-folder GET, and
    // asking for one must not fall through to the IRIS proxy or the SPA shell.
    const { status, body } = await get(startApp(populated), '/api/sample-data/folders/Test1');
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.folders).toBeUndefined();
  });

  it('reports a real read failure as a 500 envelope rather than an empty dropdown', async () => {
    const dir = tempDir();
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const { status, body } = await get(startApp(locked), '/api/sample-data/folders');
      if (process.getuid?.() !== 0) {
        expect(status).toBe(500);
        expect(body.code).toBe('INTERNAL');
        expect(body.folders).toBeUndefined();
      }
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

// ---------------------------------------------------------- POST /load -------

/** A SampleData directory holding one set with the given files. */
function setWith(files: Record<string, string>, folder = 'Test1'): string {
  const root = tempDir();
  mkdirSync(join(root, folder));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, folder, name), text);
  return root;
}

/**
 * Small but REAL example CSVs. Every header is its target table's OWN column name — the
 * guarantee the loader now rests on ("the column headers in the CSV will match the column
 * names in the tables") — except the key, which the sets spell `ID`. Case is deliberately
 * mixed: a column is matched case-insensitively, so `Name` and `name` are the same column.
 */
const CSV = {
  locations:
    'ID,Name,Type,Status,Street,City,stateProvince,Country,postalCode,Coordinates\n' +
    'LOC-1,Plant,Plant,Active,1 Way,Ede,GLD,NL,6710,"52.03, 5.66"\n',
  carriers: 'ID,Name,Type,Status\nCAR-1,Speedy,Road,Active\n',
  customers: 'ID,Name,Type,Status,primaryLocationId\nCUS-1,Acme,Retail,Active,LOC-1\n',
  salesOrders:
    'ID,customerId,orderStatus,orderPlacedDate,shipToLocationId,orderValue,orderCurrency,' +
    'requestedShipDate,requestedDeliveryDate,committedShipDate,committedDeliveryDate\n' +
    'SO-1,CUS-1,Open,2026-01-02 00:00:00,LOC-1,100,EUR,,,,\n',
  salesOrderLines:
    'ID,salesOrderId,lineNumber,productId,quantity,unitOfMeasure,status,value,valueCurrency\n' +
    'SOL-1,SO-1,1,PRD-1,5,EA,Open,100,EUR\n',
};

/** The SC_Data foreign keys these tests order by, as IRIS reports them. */
const ORDER_KEYS = {
  Customer: [{ column: 'primaryLocationId', parentTable: 'Location' }],
  SalesOrder: [
    { column: 'customerId', parentTable: 'Customer' },
    { column: 'shipToLocationId', parentTable: 'Location' },
  ],
  SalesOrderLine: [{ column: 'salesOrderId', parentTable: 'SalesOrder' }],
};

describe('POST /api/sample-data/load', () => {
  it('adds each CSV to its own SC_Data table and reports what landed', async () => {
    // The feature, stated as SQL: the rows end up in the SCO data model's tables.
    const dir = setWith({ 'carriers.csv': CSV.carriers, 'locations.csv': CSV.locations });
    const iris = createFakeScDataIris();

    const { status, body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.schema).toBe('SC_Data');
    expect(body.folder).toBe('Test1');
    expect(body.totalRows).toBe(2);
    expect(body.totalSkippedRows).toBe(0);
    // Neither table references the other, so the order is the caller's (alphabetical).
    expect(body.tables).toEqual([
      { file: 'carriers.csv', table: 'Carrier', ok: true, columns: 4, rows: 1, skippedRows: 0, orphanRows: 0 },
      { file: 'locations.csv', table: 'Location', ok: true, columns: 10, rows: 1, skippedRows: 0, orphanRows: 0 },
    ]);
    expect(iris.rows('Location')).toEqual(['LOC-1']);
    expect(iris.rows('Carrier')).toEqual(['CAR-1']);
  });

  it('never creates, drops or empties a table: the SC_Data tables are the product\'s', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    const iris = createFakeScDataIris();
    await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(iris.sql.filter((s) => /^(CREATE|DROP|DELETE|TRUNCATE|ALTER|INSERT|UPDATE)/i.test(s))).toEqual([]);
    expect(iris.loads()).toHaveLength(1);
  });

  it('loads PARENTS FIRST, not in the alphabetical order the directory lists', async () => {
    // SC_Data has real FOREIGN KEYs: a SalesOrder needs its Customer, which needs its
    // Location. Alphabetically the set would load salesOrderLines before salesOrders.
    // The order comes from the keys IRIS reports, so the fake has to report them.
    const dir = setWith({
      'salesOrderLines.csv': CSV.salesOrderLines,
      'salesOrders.csv': CSV.salesOrders,
      'customers.csv': CSV.customers,
      'locations.csv': CSV.locations,
    });
    const iris = createFakeScDataIris({ foreignKeys: ORDER_KEYS });
    const { body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(body.tables?.map((t) => t.table)).toEqual([
      'Location',
      'Customer',
      'SalesOrder',
      'SalesOrderLine',
    ]);
    expect(body.ok).toBe(true);
    expect(body.totalRows).toBe(4);
  });

  it('is repeatable: a second load adds nothing and says how many rows it SKIPPED', async () => {
    // The user's rule: "if a UID exists ignore that row and continue with the others".
    const dir = setWith({ 'carriers.csv': CSV.carriers, 'locations.csv': CSV.locations });
    const iris = createFakeScDataIris();
    const base = startApp(dir, iris.deps); // one IRIS across both calls

    const first = await postLoad(base, { folder: 'Test1' });
    const second = await postLoad(base, { folder: 'Test1' });

    expect(first.body.totalRows).toBe(2);
    // Doubling here would mean a re-load duplicates the user's data.
    expect(second.body.totalRows).toBe(0);
    expect(second.body.totalSkippedRows).toBe(2);
    expect(second.body.ok).toBe(true); // skipping known rows is a success, not a failure
    expect(second.body.tables?.find((t) => t.file === 'locations.csv')).toEqual({
      file: 'locations.csv',
      table: 'Location',
      ok: true,
      columns: 10,
      rows: 0,
      skippedRows: 1,
      orphanRows: 0,
    });
    expect(iris.rows('Location')).toEqual(['LOC-1']);
  });

  it('SKIPS a CSV no SC_Data table takes, reports it, and loads the rest', async () => {
    // The user's rule: "the files in the folder will always have a matching SC_Data
    // table, but if it does not exist then skip that csv and report it".
    const dir = setWith({ 'carriers.csv': CSV.carriers, 'notes.csv': 'a,b\n1,2\n' });
    const iris = createFakeScDataIris();
    const { body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(body.ok).toBe(true); // a reported skip is not a failure
    expect(body.totalRows).toBe(1);
    expect(body.tables?.[1]).toEqual({
      file: 'notes.csv',
      table: 'notes',
      ok: true,
      skipped: true,
      reason: 'No SC_Data table takes notes.csv, so it was skipped.',
    });
    // Nothing about it reached IRIS.
    expect(iris.sql.some((s) => s.includes('notes'))).toBe(false);
  });

  it('SKIPS a CSV whose table THIS namespace does not have', async () => {
    // A name is not enough on its own: `locations.csv` is a perfectly good file, and on an
    // instance where SCO never installed `SC_Data.Location` it still has nowhere to go. The
    // file names are matched against the tables IRIS reports, so an absent table is a
    // reported skip and not an attempted load against a table that isn't there.
    const dir = setWith({ 'carriers.csv': CSV.carriers, 'locations.csv': CSV.locations });
    const iris = createFakeScDataIris({ tables: { Location: null } });
    const { body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(body.tables?.find((t) => t.file === 'locations.csv')).toEqual({
      file: 'locations.csv',
      table: 'locations',
      ok: true,
      skipped: true,
      reason: 'No SC_Data table takes locations.csv, so it was skipped.',
    });
    expect(body.ok).toBe(true);
    expect(body.totalRows).toBe(1); // carriers still loaded
    expect(iris.loads()).toHaveLength(1);
    // Not one statement mentioned the table it would have gone into.
    expect(iris.sql.some((s) => s.includes('"Location"'))).toBe(false);
  });

  it('LOADS a CSV for an installed table no shipped set has ever had a file for', async () => {
    // ~14 of the installed SC_Data tables are not covered by any shipped example file. A set
    // that brings one of them must load, or every new example file is a code change.
    // `mfgOrders.csv` finds `SC_Data.MfgOrder` by name and its headers are that table's own
    // column names, which is all the loader ever needed.
    const iris = createFakeScDataIris({
      tables: { MfgOrder: ['uid', 'productId', 'quantity', 'status'] },
    });
    const dir = setWith({
      'carriers.csv': CSV.carriers,
      'mfgOrders.csv': 'ID,productId,quantity,status\nMO-1,PRD-1,7,Released\n',
    });
    const { body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(body.ok).toBe(true);
    expect(body.tables?.find((t) => t.file === 'mfgOrders.csv')).toEqual({
      file: 'mfgOrders.csv',
      table: 'MfgOrder',
      ok: true,
      columns: 4,
      rows: 1,
      skippedRows: 0,
      orphanRows: 0,
    });
    expect(iris.rows('MfgOrder')).toEqual(['MO-1']);
  });

  it('orders two never-before-seen files by their OWN foreign keys, not by the directory', async () => {
    // `SC_Data.Issue` here references `Milestone`, and nothing in this repo knows either
    // file. Listed alphabetically the child comes first, which would orphan its row — so
    // the order has to come from the FK graph IRIS reports, and nothing else.
    const iris = createFakeScDataIris({
      tables: { Issue: ['uid', 'milestoneId', 'summary'], Milestone: ['uid', 'name'] },
      foreignKeys: { Issue: [{ column: 'milestoneId', parentTable: 'Milestone' }] },
    });
    const dir = setWith({
      'issues.csv': 'ID,milestoneId,summary\nISS-1,MS-1,Late\n',
      'milestones.csv': 'ID,name\nMS-1,Kickoff\n',
    });
    const { body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(body.tables?.map((t) => t.table)).toEqual(['Milestone', 'Issue']);
    expect(body.totalRows).toBe(2);
    // The point of the order: the issue's parent was there, so its row is not an orphan.
    expect(body.totalOrphanRows).toBe(0);
    expect(iris.rows('Issue')).toEqual(['ISS-1']);
  });

  it('REPORTS a header that landed in no column, on an otherwise successful load', async () => {
    // The silent case this exists to end: a column the file has and the table does not
    // (`products.csv` really ships an `ImageUrl` SC_Data has no home for). The rows load;
    // that column's values did not, and the page has to be able to say so.
    const dir = setWith({
      'carriers.csv': 'ID,Name,Type,Status,Colour,Fleet Size\nCAR-1,Speedy,Road,Active,red,12\n',
    });
    const { body } = await postLoad(startApp(dir), { folder: 'Test1' });

    expect(body.ok).toBe(true); // not an error: the rows are in
    expect(body.totalRows).toBe(1);
    expect(body.totalIgnoredHeaders).toBe(2);
    expect(body.tables?.[0]?.ignoredHeaders).toEqual(['Colour', 'Fleet Size']);
  });

  it('leaves ignoredHeaders OFF a file whose every header found a column', async () => {
    // An absent key reads as "nothing was left behind"; an empty array in every report
    // would train the page to ignore it.
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    const { body } = await postLoad(startApp(dir), { folder: 'Test1' });

    expect(body.tables?.[0]).not.toHaveProperty('ignoredHeaders');
    expect(body.totalIgnoredHeaders).toBe(0);
  });

  it('ignores everything in the set that is not a CSV file', async () => {
    const dir = setWith({
      'carriers.csv': CSV.carriers,
      'README.txt': 'notes',
      '.DS_Store': 'junk',
      'notes.csv.bak': 'a\n1\n',
    });
    const { body } = await postLoad(startApp(dir), { folder: 'Test1' });
    expect(body.tables?.map((t) => t.file)).toEqual(['carriers.csv']);
  });

  it('400s on a body that does not name a set, without touching IRIS', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    const iris = createFakeScDataIris();
    const base = startApp(dir, iris.deps);

    for (const payload of [{}, { folder: '' }, { folder: '   ' }, { folder: 42 }, { folder: null }, { folder: ['Test1'] }]) {
      const { status, body } = await postLoad(base, payload);
      expect(status, JSON.stringify(payload)).toBe(400);
      expect(body.code).toBe('VALIDATION');
      expect(body.tables).toBeUndefined();
    }
    expect(iris.sql).toEqual([]);
  });

  it('rejects a body that is not a JSON object at all (documenting the 500)', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    const iris = createFakeScDataIris();
    const base = startApp(dir, iris.deps);

    for (const payload of ['Test1', null, 7]) {
      const { status, body } = await postLoad(base, payload);
      // express.json() runs in strict mode and rejects a non-object body before the
      // route sees it. Its error carries status 400, but errorEnvelope only honours
      // an IrisError's status, so this surfaces as 500 INTERNAL: app-wide behaviour
      // for every POST route, not something this endpoint decides. Nothing is loaded
      // either way, which is what matters here.
      expect(status, JSON.stringify(payload)).toBe(500);
      expect(body.tables).toBeUndefined();
    }
    expect(iris.sql).toEqual([]);
  });

  it('404s for a set that does not exist', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    const iris = createFakeScDataIris();
    const { status, body } = await postLoad(startApp(dir, iris.deps), { folder: 'Nope' });

    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toContain('"Nope"');
    expect(iris.sql).toEqual([]);
  });

  it('404s a TRAVERSAL attempt instead of reading outside the SampleData directory', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    // A secret CSV one level up, which a traversal would happily read.
    writeFileSync(join(dir, 'secrets.csv'), 'password\nhunter2\n');
    const iris = createFakeScDataIris();
    const base = startApp(dir, iris.deps);

    // (An untrimmed '  Test1  ' is deliberately NOT here: the route trims first, so it
    // is the same set. See the trimming test below.)
    for (const folder of ['..', '../..', '.', 'Test1/..', '../Test1', '/etc', 'Test1/nested', '..\\Test1']) {
      const { status, body } = await postLoad(base, { folder });
      expect(status, folder).toBe(404);
      expect(body.code).toBe('NOT_FOUND');
    }
    // Not one statement ran: the name never became a path.
    expect(iris.sql).toEqual([]);
  });

  it('reports a set with NO CSV files as ok:false rather than a green "done"', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Empty')); // like the real SampleData/Test2
    const { status, body } = await postLoad(startApp(dir), { folder: 'Empty' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ folder: 'Empty', tables: [], totalRows: 0, ok: false });
  });

  it('loads the GOOD files and reports the bad one, in the same 200', async () => {
    // A partial load is a real outcome; failing the whole request would throw away
    // work IRIS already did.
    const dir = setWith({
      // A real table, but no ID column, so its rows have no key.
      'carriers.csv': 'Name,Type,Status\nSpeedy,Road,Active\n',
      'customers.csv': '', // no header row at all
      'locations.csv': CSV.locations,
      'salesOrders.csv': CSV.salesOrders,
    });
    const { status, body } = await postLoad(startApp(dir), { folder: 'Test1' });

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.totalRows).toBe(2); // only the two good files' rows
    expect(body.tables?.map((t) => [t.file, t.ok])).toEqual([
      ['carriers.csv', false],
      ['customers.csv', false],
      ['locations.csv', true], // a failure does not stop the rest of the set
      ['salesOrders.csv', true],
    ]);
    // Each failure explains itself, naming its own file.
    expect(body.tables?.[0]?.error).toMatch(/carriers\.csv has no UID or ID column/);
    expect(body.tables?.[1]?.error).toMatch(/customers\.csv is empty/);
    // A failed file still reports the table it would have gone into, and no row count.
    expect(body.tables?.[0]?.table).toBe('Carrier');
    expect(body.tables?.[0]?.rows).toBeUndefined();
  });

  it('reports a per-file SQL error as that file\'s failure only', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers, 'locations.csv': CSV.locations });
    // A SQL error for ONE table (say a value too wide for its column) is not a reason
    // to abandon the set: only a dead connection is.
    const iris = createFakeScDataIris({ failOn: /INTO SC_Data\."Location"/ });
    const { status, body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(status).toBe(200);
    expect(body.tables?.map((t) => t.ok)).toEqual([true, false]);
    expect(body.tables?.[1]?.error).toContain('SQLCODE -400');
    // The staged file went away even though the load failed.
    expect([...iris.files.keys()]).toEqual([]);
  });

  it('LEAVES OUT rows whose parent row is missing, and reports them per file and in total', async () => {
    // The set that produced the bug report: no locations.csv, so SC_Data.Location is
    // empty and every customer's primaryLocationId points at nothing. IRIS would
    // reject all of them — slowly, one batch error per row — so they are left out here
    // and REPORTED instead.
    const dir = setWith({ 'customers.csv': CSV.customers });
    const iris = createFakeScDataIris({
      foreignKeys: { Customer: [{ column: 'primaryLocationId', parentTable: 'Location' }] },
    });
    const { status, body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(status).toBe(200);
    expect(body.totalRows).toBe(0);
    expect(body.totalOrphanRows).toBe(1);
    expect(body.tables?.[0]).toMatchObject({
      file: 'customers.csv',
      table: 'Customer',
      ok: true,
      rows: 0,
      orphanRows: 1,
    });
    // The reason names the table the user has to load first, not just a count.
    expect(body.tables?.[0]?.orphanReason).toContain('SC_Data.Location');
    // With every row dropped there is nothing to load, so IRIS is never asked to.
    expect(iris.loads()).toEqual([]);
  });

  it('loads the very same row once the set brings the parent with it', async () => {
    const dir = setWith({ 'customers.csv': CSV.customers, 'locations.csv': CSV.locations });
    const iris = createFakeScDataIris({
      foreignKeys: { Customer: [{ column: 'primaryLocationId', parentTable: 'Location' }] },
    });
    const { body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    // Location loads first (parents first), so by the time Customer is checked its
    // LOC-1 is there.
    expect(body.ok).toBe(true);
    expect(body.totalRows).toBe(2);
    expect(body.totalOrphanRows).toBe(0);
    expect(iris.rows('Customer')).toEqual(['CUS-1']);
  });

  it('KEEPS the partial report when IRIS dies part way, rather than 504ing it away', async () => {
    // The bug behind "request timed out after 30000ms" with nothing to show: the files
    // that already landed were thrown away with the error.
    const dir = setWith({
      'locations.csv': CSV.locations,
      'customers.csv': CSV.customers,
      'salesOrders.csv': CSV.salesOrders,
    });
    const iris = createFakeScDataIris({
      // Customer references Location, so locations.csv is in before the file that dies.
      foreignKeys: { Customer: ORDER_KEYS.Customer },
      failOn: /INTO SC_Data\."Customer"/,
      throws: () => new IrisTimeoutError('Atelier request: request timed out after 30000ms'),
    });
    const { status, body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(status).toBe(200); // NOT 504 — there is a report to deliver
    expect(body.ok).toBe(false); // but it is not a success either
    expect(body.aborted).toContain('customers.csv');
    expect(body.aborted).toContain('timed out');
    // What landed is still stated, and the file it died on is a failure.
    expect(body.totalRows).toBe(1);
    expect(body.tables?.map((t) => [t.file, t.ok])).toEqual([
      ['locations.csv', true],
      ['customers.csv', false],
    ]);
    // It stopped: salesOrders.csv was never attempted (Customer's load was, and threw).
    expect(iris.loads().some((s) => s.includes('"SalesOrder"'))).toBe(false);
  });

  it('STOPS at a dead IRIS and answers 502 instead of grinding through every file', async () => {
    const dir = setWith({
      'carriers.csv': CSV.carriers,
      'locations.csv': CSV.locations,
      'customers.csv': CSV.customers,
    });
    const iris = createFakeScDataIris({
      failOn: /INFORMATION_SCHEMA/,
      throws: () => new IrisUnreachableError('IRIS is unreachable (ECONNREFUSED)'),
    });
    const { status, body } = await postLoad(startApp(dir, iris.deps), { folder: 'Test1' });

    expect(status).toBe(502);
    expect(body.code).toBe('SCO_UNREACHABLE');
    // No partial report to misread, and it gave up on the FIRST statement — reading the
    // installed schema, before any file — rather than on three files' worth of retries
    // and timeouts.
    expect(body.tables).toBeUndefined();
    expect(iris.sql).toHaveLength(1);
    expect(iris.loads()).toEqual([]);
  });

  it('maps a timeout to 504 and an auth failure to 502, with their own codes', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    const timedOut = await postLoad(
      startApp(
        dir,
        createFakeScDataIris({ failOn: /INFORMATION_SCHEMA/, throws: () => new IrisTimeoutError('timed out') }).deps,
      ),
      { folder: 'Test1' },
    );
    expect(timedOut.status).toBe(504);
    expect(timedOut.body.code).toBe('SCO_TIMEOUT');

    const rejected = await postLoad(
      startApp(
        dir,
        createFakeScDataIris({ failOn: /INFORMATION_SCHEMA/, throws: () => new IrisAuthError('bad credentials') }).deps,
      ),
      { folder: 'Test1' },
    );
    expect(rejected.status).toBe(502);
    expect(rejected.body.code).toBe('SCO_AUTH');
  });

  it('trims the requested name but does not otherwise rewrite it', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers }, 'Sales by Region');
    const { status, body } = await postLoad(startApp(dir), { folder: '  Sales by Region  ' });
    expect(status).toBe(200);
    expect(body.folder).toBe('Sales by Region');
  });

  it('404s a GET on the load path (it is a POST-only action)', async () => {
    const { status, body } = await get(startApp(populated), '/api/sample-data/load');
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});

// -------------------------------------------------------- GET /tables --------
//
// The list the page shows the moment a set is picked: which SC_Data tables a Load would
// put rows in. It resolves and orders the files exactly as POST /load does, so the pair
// of them is what these tests check — a preview that described a different load would be
// worse than none. It must also load NOTHING, which is asserted rather than assumed.

interface PreviewBody {
  folder?: string;
  schema?: string;
  tables?: Array<{ file: string; table: string; willLoad: boolean }>;
  intro?: string;
  verified?: boolean;
  reason?: string;
  error?: string;
  code?: string;
}

async function getTables(base: string, query: string) {
  const res = await fetch(`${base}/api/sample-data/tables${query}`);
  return { status: res.status, body: (await res.json()) as PreviewBody };
}

describe('GET /api/sample-data/tables', () => {
  it('names the table each CSV would go into, in the order they would load', async () => {
    const dir = setWith({
      'salesOrderLines.csv': CSV.salesOrderLines,
      'salesOrders.csv': CSV.salesOrders,
      'customers.csv': CSV.customers,
      'locations.csv': CSV.locations,
    });
    const iris = createFakeScDataIris({ foreignKeys: ORDER_KEYS });

    const { status, body } = await getTables(startApp(dir, iris.deps), '?folder=Test1');

    expect(status).toBe(200);
    expect(body.folder).toBe('Test1');
    expect(body.schema).toBe('SC_Data');
    expect(body.verified).toBe(true);
    // Parents first, as the load would go — not the directory's alphabetical order.
    expect(body.tables).toEqual([
      { file: 'locations.csv', table: 'Location', willLoad: true },
      { file: 'customers.csv', table: 'Customer', willLoad: true },
      { file: 'salesOrders.csv', table: 'SalesOrder', willLoad: true },
      { file: 'salesOrderLines.csv', table: 'SalesOrderLine', willLoad: true },
    ]);
  });

  it('LOADS NOTHING: it reads the schema and stops', async () => {
    // The whole point is that this runs on a mere dropdown change. Staging a file or
    // running a LOAD DATA there would write to the user's tables without a click.
    const dir = setWith({ 'carriers.csv': CSV.carriers, 'locations.csv': CSV.locations });
    const iris = createFakeScDataIris();

    await getTables(startApp(dir, iris.deps), '?folder=Test1');

    expect(iris.loads()).toEqual([]);
    expect(iris.files.size).toBe(0);
    expect(iris.staged('Carrier')).toBeUndefined();
    expect(iris.rows('Carrier')).toEqual([]);
    // Two statements only: the installed tables and the FK graph.
    expect(iris.sql).toHaveLength(2);
    expect(iris.sql.every((s) => s.includes('INFORMATION_SCHEMA'))).toBe(true);
  });

  it('flags a file NO installed table takes instead of leaving it out', async () => {
    // Same outcome the load reports as `skipped`. Omitting it would read as "this set
    // loads everything", which is how a typo in a file name goes unnoticed.
    const dir = setWith({
      'carriers.csv': CSV.carriers,
      'notes.csv': 'a,b\n1,2\n',
      'mfgOrders.csv': 'ID\nMO-1\n',
    });
    // MfgOrder is a real SC_Data table, but not one this namespace has installed here.
    const iris = createFakeScDataIris();

    const { body } = await getTables(startApp(dir, iris.deps), '?folder=Test1');

    expect(body.tables).toEqual([
      { file: 'carriers.csv', table: 'Carrier', willLoad: true },
      { file: 'mfgOrders.csv', table: 'mfgOrders', willLoad: false },
      { file: 'notes.csv', table: 'notes', willLoad: false },
    ]);
  });

  it('agrees with the load it describes, file for file', async () => {
    // The guarantee that matters: preview and load resolve and order through the same
    // code, so the list the user reads is the plan that then runs.
    const dir = setWith({
      'salesOrders.csv': CSV.salesOrders,
      'customers.csv': CSV.customers,
      'locations.csv': CSV.locations,
      'notes.csv': 'a\n1\n',
    });
    const iris = createFakeScDataIris({ foreignKeys: ORDER_KEYS });
    const base = startApp(dir, iris.deps);

    const preview = await getTables(base, '?folder=Test1');
    const load = await postLoad(base, { folder: 'Test1' });

    expect(preview.body.tables?.map((t) => [t.file, t.table])).toEqual(
      load.body.tables?.map((t) => [t.file, t.table]),
    );
    expect(preview.body.tables?.map((t) => t.willLoad)).toEqual(
      load.body.tables?.map((t) => t.skipped !== true),
    );
  });

  it('answers an EMPTY set with an empty list, not a failure', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Test1'));

    const { status, body } = await getTables(startApp(dir), '?folder=Test1');

    expect(status).toBe(200);
    expect(body).toEqual({ folder: 'Test1', schema: 'SC_Data', tables: [], verified: true });
  });

  it('still names the tables the set is FOR when IRIS cannot be asked', async () => {
    // A dropdown change must not turn into an error banner because IRIS is down: the
    // file names alone say what the set is for. But the answer says it is UNCHECKED,
    // so the page cannot present it as the installed truth.
    const dir = setWith({ 'carriers.csv': CSV.carriers, 'locations.csv': CSV.locations });
    const iris = createFakeScDataIris({
      failOn: /INFORMATION_SCHEMA/,
      throws: () => new IrisUnreachableError('IRIS is unreachable (ECONNREFUSED)'),
    });

    const { status, body } = await getTables(startApp(dir, iris.deps), '?folder=Test1');

    expect(status).toBe(200);
    expect(body.verified).toBe(false);
    expect(body.reason).toContain('ECONNREFUSED');
    // Named after the FILES, since nothing could be resolved — and in the directory's
    // own order, there being no FK graph to order by.
    expect(body.tables).toEqual([
      { file: 'carriers.csv', table: 'carriers', willLoad: true },
      { file: 'locations.csv', table: 'locations', willLoad: true },
    ]);
    expect(iris.loads()).toEqual([]);
  });

  it('sends what the set SAYS ABOUT ITSELF alongside the tables', async () => {
    const dir = setWith({
      'intro.txt': 'Healthcare demo generator output.\nLoads 2 files.\n',
      'carriers.csv': CSV.carriers,
      'locations.csv': CSV.locations,
    });

    const { body } = await getTables(startApp(dir, createFakeScDataIris().deps), '?folder=Test1');

    expect(body.intro).toBe('Healthcare demo generator output.\nLoads 2 files.');
    // And it is a DESCRIPTION, not data: nothing in the list is the intro file.
    expect(body.tables).toEqual([
      { file: 'carriers.csv', table: 'Carrier', willLoad: true },
      { file: 'locations.csv', table: 'Location', willLoad: true },
    ]);
  });

  it('omits the key entirely for a set with nothing to say', async () => {
    // Not `intro: ''` — an empty string is something the page would have to decide about,
    // and a set without a description is the ordinary case, not a degraded one.
    const dir = setWith({ 'carriers.csv': CSV.carriers });

    const { body } = await getTables(startApp(dir, createFakeScDataIris().deps), '?folder=Test1');

    expect(body.intro).toBeUndefined();
    expect('intro' in body).toBe(false);
  });

  it('still says what the set is when IRIS cannot be asked', async () => {
    // The description comes from the FILES, so it does not depend on the namespace: the
    // one branch where the table names are guesses is the branch that most needs it.
    const dir = setWith({ 'intro.txt': 'Development data set.', 'carriers.csv': CSV.carriers });
    const iris = createFakeScDataIris({
      failOn: /INFORMATION_SCHEMA/,
      throws: () => new IrisUnreachableError('IRIS is unreachable (ECONNREFUSED)'),
    });

    const { status, body } = await getTables(startApp(dir, iris.deps), '?folder=Test1');

    expect(status).toBe(200);
    expect(body.verified).toBe(false);
    expect(body.intro).toBe('Development data set.');
  });

  it('never lets a broken intro cost the table list', async () => {
    // A directory named intro.txt is the shape of the accident (a set copied wrongly),
    // and the tables are what the page is actually for.
    const dir = setWith({ 'carriers.csv': CSV.carriers });
    mkdirSync(join(dir, 'Test1', 'intro.txt'));

    const { status, body } = await getTables(startApp(dir, createFakeScDataIris().deps), '?folder=Test1');

    expect(status).toBe(200);
    expect(body.intro).toBeUndefined();
    expect(body.tables).toEqual([{ file: 'carriers.csv', table: 'Carrier', willLoad: true }]);
  });

  it('does not LOAD the intro: it is not one of the set\'s files', async () => {
    // It would otherwise show up as a file no table takes — reported as a skip, which
    // would read as a fault in the set on every single load.
    const dir = setWith({ 'intro.txt': 'Two files.', 'carriers.csv': CSV.carriers });
    const iris = createFakeScDataIris();
    const base = startApp(dir, iris.deps);

    const preview = await getTables(base, '?folder=Test1');
    const load = await postLoad(base, { folder: 'Test1' });

    expect(preview.body.tables?.map((t) => t.file)).toEqual(['carriers.csv']);
    expect(load.body.tables?.map((t) => t.file)).toEqual(['carriers.csv']);
    expect(load.body.ok).toBe(true);
    expect(iris.staged('Carrier')).not.toContain('Two files.');
  });

  it('400s without a folder, and 404s an unknown one or a traversal attempt', async () => {
    const base = startApp(populated);

    const missing = await getTables(base, '');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('VALIDATION');

    const blank = await getTables(base, '?folder=%20%20');
    expect(blank.status).toBe(400);

    const unknown = await getTables(base, '?folder=Nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('NOT_FOUND');
    expect(unknown.body.tables).toBeUndefined();

    // Rejected as "not a data set", the same as the load: the name is checked against
    // the listing, so it can never become a path.
    for (const name of ['..', '../..', '%2e%2e%2f', '/etc', '.hidden']) {
      const escaped = await getTables(base, `?folder=${encodeURIComponent(name)}`);
      expect([404, 400], name).toContain(escaped.status);
      expect(escaped.body.tables, name).toBeUndefined();
    }
  });

  it('trims the requested name but does not otherwise rewrite it', async () => {
    const dir = setWith({ 'carriers.csv': CSV.carriers }, 'Sales by Region');
    const { status, body } = await getTables(startApp(dir), '?folder=%20%20Sales%20by%20Region%20%20');
    expect(status).toBe(200);
    expect(body.folder).toBe('Sales by Region');
    expect(body.tables).toEqual([{ file: 'carriers.csv', table: 'Carrier', willLoad: true }]);
  });

  it('404s a POST to the table list (it reads, it does not act)', async () => {
    const res = await fetch(`${startApp(populated)}/api/sample-data/tables`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder: 'Test1' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as PreviewBody).code).toBe('NOT_FOUND');
  });
});
