/**
 * "Load sample data" against a live IRIS: POST /api/sample-data/load adds a set's
 * CSVs to the SCO data model's OWN tables (`SC_Data.Location`, `SC_Data.SalesOrder`, …)
 * in the configured namespace, and every row is then read back WITH SQL rather than
 * trusted from the response.
 *
 * This is where the real mechanism is proved, because none of it can be faked: the CSV
 * is staged INSIDE the IRIS container over the Native SDK, IRIS's own `LOAD DATA` reads
 * it, the tables have real PRIMARY KEY and FOREIGN KEY constraints, and the date
 * columns are real timestamps.
 *
 * Nothing here is described by a table in this repo. Each fixture file is matched to an
 * installed `SC_Data` table by its NAME and each header to that table's own COLUMN name,
 * both read out of `INFORMATION_SCHEMA` on the live instance — so these fixtures are
 * written the way a real set is guaranteed to be ("the CSV file names match the table
 * name and the column headers match the column names"), and the last test in the file
 * checks that guarantee against the live schema rather than assuming it.
 *
 * The fixtures are deliberately awkward otherwise: a quoted comma inside `coordinates`, a
 * quoted NEWLINE inside a name, CRLF line endings, non-ASCII text, a blank cell that must
 * become NULL rather than 0, a microsecond timestamp, a file of 600 rows (three uid-probe
 * chunks), a repeated uid and a blank one, `Yes`/`No` written into a real `bit` column (and
 * beside it a VARCHAR holding the word `No`, which must survive), a `products.csv` keyed
 * `UID` instead of `ID`, headers whose CASE differs from the column's, a header no column
 * has at all (`Nonsense`), and the identity `ID` of an SC_Data export, which must not be
 * written.
 *
 * SAFE ON A REAL INSTANCE, which matters because these are the user's product tables:
 * nothing is created, dropped or emptied, every fixture uid is prefixed `WB_IT_`, and
 * cleanup is a surgical `DELETE … WHERE uid LIKE 'WB_IT%'` (children before parents, so
 * the FOREIGN KEYs allow it). A user's own rows cannot be touched by any of it.
 *
 * Live IRIS required; run via: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { fileExistsInIris } from '../../src/iris/file-ops.js';
import { KEY_HEADERS, resolveScDataTable } from '../../src/util/sc-data-mapping.js';

const d = describe;

/** Staging dir inside IRIS for this suite, so it cannot collide with a real upload. */
const STAGE_DIR = '/tmp/sco-workbench/csv-it';

/** Prefix on every uid this suite writes; the cleanup key. */
const UID = 'WB_IT';

/**
 * Tables this suite writes to, CHILDREN FIRST — the delete order the FOREIGN KEYs
 * require (a SalesOrder cannot go while a SalesOrderLine still points at it).
 */
const TOUCHED = [
  'SalesOrderLine',
  'SalesOrder',
  'DemandPlan',
  'Customer',
  'Carrier',
  'BOM',
  'TrackingService',
  'Product',
  'Location',
];

/** 600 carriers: three uid-probe chunks and one big LOAD DATA. */
const BIG_ROWS = 600;

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

/**
 * CRLF, a quoted comma, a quoted newline, unicode, two blank cells — and three columns no
 * shipped example file uses: `Region` and `Latitude`, which `SC_Data.Location` really has
 * (verified 2026-09-08: varchar, updatable, and spelled `region`/`latitude`, so their case
 * here differs from the column's), and `Nonsense`, which the table does not have at all.
 * The first two must land and the third must be ignored without disturbing them.
 */
const LOCATIONS_CSV = [
  'ID,Name,Type,Status,Street,City,stateProvince,Country,postalCode,Coordinates,Region,Latitude,Nonsense',
  `${UID}_LOC_1,"Plant, North",Plant,Active,1 Way,Ede,GLD,NL,6710,"52.03, 5.66",EMEA,52.03,ignore me`,
  `${UID}_LOC_2,Éclair Hub,DistributionCenter,Active,2 Rue,Paris,IDF,FR,,"48.85, 2.35",EMEA,48.85,ignore me`,
  `${UID}_LOC_3,"multi\nline",Store,Active,3 St,Boston,MA,US,02451,,AMER,42.39,ignore me`,
].join('\r\n');

const CARRIERS_CSV = ['ID,Name,Type,Status']
  .concat(Array.from({ length: BIG_ROWS }, (_, i) => `${UID}_CAR_${i + 1},Carrier ${i + 1},Road,Active`))
  .join('\n');

/**
 * Keyed with `UID` rather than `ID` — the spelling a set exported straight out of
 * SC_Data carries. Both are accepted, and this file proves it on the real statement:
 * if the alias were dropped, these rows would be missing and the FOREIGN KEY join
 * test below would fail with them.
 */
const PRODUCTS_CSV = [
  'UID,Name,Type,productBrand,productCategory,productFamily',
  `${UID}_PRD_1,Widget,Finished,Acme,Tools,Hand`,
  `${UID}_PRD_2,Gadget,Finished,Acme,Tools,Power`,
].join('\n');

/**
 * Written the way a set EXPORTED OUT OF SC_Data would be: the columns in a different order
 * from the table's, a `url` column no shipped file uses but the table really has, and BOTH
 * keys — `uid` (the business key) and `ID` (the internal row id, IS_IDENTITY). The `uid` has
 * to win and the `ID` must not be sent at all; a positional load, or one that read `ID` as
 * the key, would put `999999` in the primary key and orphan the order and line below
 * without erroring at all.
 */
const CUSTOMERS_CSV = [
  'primaryLocationId,Status,Name,Type,uid,ID,url',
  `${UID}_LOC_1,Active,Acme Retail,Retail,${UID}_CUS_1,999999,https://acme.example`,
].join('\n');

/** A microsecond timestamp, a decimal value, and two blank date columns. */
const SALES_ORDERS_CSV = [
  'ID,customerId,orderStatus,orderPlacedDate,shipToLocationId,orderValue,orderCurrency,' +
    'requestedShipDate,requestedDeliveryDate,committedShipDate,committedDeliveryDate',
  `${UID}_SO_1,${UID}_CUS_1,Open,2026-01-02 16:53:56.211463,${UID}_LOC_1,100.5,EUR,` +
    '2026-01-03 00:00:00,2026-01-09 00:00:00,,',
].join('\n');

const SALES_ORDER_LINES_CSV = [
  'ID,salesOrderId,lineNumber,productId,quantity,unitOfMeasure,status,value,valueCurrency',
  `${UID}_SOL_1,${UID}_SO_1,1,${UID}_PRD_1,5,EA,Open,100.5,EUR`,
].join('\n');

/**
 * `SC_Data.DemandPlan`'s own column names, and NO `quantityUom` column at all — a column
 * the table has and the file does not is simply not loaded, rather than failing the file.
 */
const DEMAND_PLAN_CSV = [
  'ID,productId,locationId,startDate,timeFrameDays,Quantity',
  `${UID}_DP_1,${UID}_PRD_1,${UID}_LOC_1,2026-02-01 00:00:00,7,42`,
].join('\n');

/**
 * A customer whose `primaryLocationId` names a Location NOTHING in this namespace has
 * — the shape of the set that produced the bug report (a generator set that ships no
 * `locations.csv`). `SC_Data.Customer.primaryLocationIdFK` is a real FOREIGN KEY, so
 * IRIS rejects such a row with SQLCODE -121 while still reporting `status: Complete`,
 * one batch error per row and ~57 s per 1,000 rows. It must be left out before the
 * load, and reported.
 */
const ORPHAN_CUSTOMERS_CSV = [
  'ID,Name,Type,Status,primaryLocationId',
  `${UID}_CUS_ORPHAN,Nowhere Retail,Retail,Active,${UID}_LOC_NOPE`,
].join('\n');

/** The same file with a sibling whose location IS in the set: one drops, one loads. */
const MIXED_LOCATIONS_CSV = [
  'ID,Name,Type,Status,City,Country',
  `${UID}_LOC_9,Ninth Depot,DistributionCenter,Active,Ede,NL`,
].join('\n');
const MIXED_CUSTOMERS_CSV = [
  'ID,Name,Type,Status,primaryLocationId',
  `${UID}_CUS_OK,Here Retail,Retail,Active,${UID}_LOC_9`,
  `${UID}_CUS_GONE,Nowhere Retail,Retail,Active,${UID}_LOC_NOPE`,
].join('\n');

/**
 * A `bit` column fed the words a spreadsheet writes. `SC_Data.BOM.isAlternate` is one of
 * only four boolean columns in the whole schema, and the shipped generator's `BOM.csv`
 * fills it with `Yes`/`No` — which IRIS rejects one row at a time, slowly enough that the
 * web gateway answered HTTP 504 for a 5,103-row file. The words have to reach IRIS as
 * 1/0. `unitOfMeasure` is a VARCHAR here deliberately spelled `No`: the conversion must
 * be driven by the column's TYPE, not by the value looking boolean.
 */
const BITS_PRODUCTS_CSV = [
  'ID,Name,Type,productBrand,productCategory,productFamily',
  `${UID}_PRD_B,Assembly,Finished,Acme,Kits,Bench`,
].join('\n');
const BITS_BOM_CSV = [
  'ID,productId,itemId,parentItemId,quantity,unitOfMeasure,isAlternate,substituteFor',
  `${UID}_BOM_YES,${UID}_PRD_B,${UID}_PRD_B,,1,No,Yes,`,
  `${UID}_BOM_NO,${UID}_PRD_B,${UID}_PRD_B,,2,No,No,`,
  `${UID}_BOM_TRUE,${UID}_PRD_B,${UID}_PRD_B,,3,EACH,true,`,
  `${UID}_BOM_BLANK,${UID}_PRD_B,${UID}_PRD_B,,4,EACH,,`,
].join('\n');

/**
 * A file for a table NO SHIPPED SET HAS EVER HAD ONE FOR. `SC_Data.TrackingService` is one
 * of the ~14 installed tables the example sets do not cover, and nothing about this load is
 * written down anywhere: the table is found from the file's name (plural → singular), every
 * column is matched from the table's own column names, and
 * `stopSequencingRequired` is coerced because IRIS says it is a `bit`. `Nonsense` is
 * there to be REPORTED — a column the table does not have, on a load that otherwise
 * succeeds, is exactly what would otherwise vanish. Verified 2026-09-08: this table has
 * no FOREIGN KEYs, so `serviceProviderId` need not name a row that exists.
 */
const TRACKING_SERVICES_CSV = [
  'ID,trackingServiceProvider,serviceProviderId,startDate,endDate,' +
    'stopSequencingRequired,maximumAllowableDrivingHoursPerDay,Nonsense',
  `${UID}_TRK_1,FleetEye,${UID}_SUP_X,2026-03-01 00:00:00,2026-03-31 00:00:00,Yes,11.5,ignore me`,
  `${UID}_TRK_2,FleetEye,${UID}_SUP_Y,2026-04-01 00:00:00,,No,9,ignore me`,
].join('\n');

/** A repeated uid, a blank uid, and one genuinely new row. */
const DUPES_CSV = [
  'ID,Name,Type,Status',
  `${UID}_CAR_DUP,First,Road,Active`,
  `${UID}_CAR_DUP,Second,Air,Active`,
  ',Nameless,Road,Active',
  `${UID}_CAR_NEW,Fresh,Road,Active`,
].join('\n');

d('load sample data into SC_Data (live)', () => {
  let app: BootedApp;
  let sampleRoot: string;

  const q = <Row>(sql: string, params?: unknown[]) => app.iris.atelier.query<Row>(sql, params);

  /** How many of OUR rows a table holds. Never counts the user's own rows. */
  async function ours(table: string): Promise<number> {
    const rows = await q<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM SC_Data.${table} WHERE uid LIKE '${UID}%'`,
    );
    return Number(rows[0]?.n ?? -1);
  }

  /** Remove every row this suite wrote, children first. */
  async function purge(): Promise<void> {
    for (const table of TOUCHED) {
      await q(`DELETE FROM SC_Data.${table} WHERE uid LIKE '${UID}%'`).catch(() => undefined);
    }
  }

  async function load(folder: unknown): Promise<{ status: number; body: LoadBody }> {
    const res = await fetch(`${app.base}/api/sample-data/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    return { status: res.status, body: await jsonOf<LoadBody>(res) };
  }

  /** How many tables SC_Data has, so we can prove the load adds none. */
  async function tableCount(): Promise<number> {
    const rows = await q<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE UPPER(TABLE_SCHEMA) = 'SC_DATA'",
    );
    return Number(rows[0]?.n ?? -1);
  }

  beforeAll(async () => {
    sampleRoot = mkdtempSync(join(tmpdir(), 'wb-it-sample-data-'));
    // A set that must load whole, in FK order regardless of the alphabet.
    mkdirSync(join(sampleRoot, 'ITGood'));
    const good = (file: string, text: string) =>
      writeFileSync(join(sampleRoot, 'ITGood', file), text.endsWith('\n') ? text : `${text}\n`);
    good('locations.csv', `${LOCATIONS_CSV}\r\n`);
    good('carriers.csv', CARRIERS_CSV);
    good('products.csv', PRODUCTS_CSV);
    good('customers.csv', CUSTOMERS_CSV);
    good('salesOrders.csv', SALES_ORDERS_CSV);
    good('salesOrderLines.csv', SALES_ORDER_LINES_CSV);
    good('demandPlan.csv', DEMAND_PLAN_CSV);
    // What the real sets carry beside their CSVs: a description of the data, in the
    // spelling a Windows editor produces (CRLF, trailing blank line).
    good('intro.txt', 'This is a dataset for development purpose.\r\nThis will load 7 files.\r\n\r\n');

    // A set where one usable-looking file has no key and one file names no table at all.
    mkdirSync(join(sampleRoot, 'ITMixed'));
    writeFileSync(join(sampleRoot, 'ITMixed', 'suppliers.csv'), 'Name,Type,Status\nNoKey,Vendor,Active\n');
    writeFileSync(
      join(sampleRoot, 'ITMixed', 'products.csv'),
      `ID,Name,Type,productBrand,productCategory,productFamily\n` +
        `${UID}_PRD_9,Spare,Finished,Acme,Tools,Hand\n`,
    );
    writeFileSync(join(sampleRoot, 'ITMixed', 'notes.csv'), 'note\nnothing takes this\n');

    // A set with a repeated uid and a blank one.
    mkdirSync(join(sampleRoot, 'ITDupes'));
    writeFileSync(join(sampleRoot, 'ITDupes', 'carriers.csv'), `${DUPES_CSV}\n`);

    // A set whose only file references a Location no namespace has (no locations.csv).
    mkdirSync(join(sampleRoot, 'ITOrphan'));
    writeFileSync(join(sampleRoot, 'ITOrphan', 'customers.csv'), `${ORPHAN_CUSTOMERS_CSV}\n`);

    // The same, but bringing the parent for ONE of its two rows.
    mkdirSync(join(sampleRoot, 'ITOrphanMixed'));
    writeFileSync(join(sampleRoot, 'ITOrphanMixed', 'locations.csv'), `${MIXED_LOCATIONS_CSV}\n`);
    writeFileSync(join(sampleRoot, 'ITOrphanMixed', 'customers.csv'), `${MIXED_CUSTOMERS_CSV}\n`);

    // A set whose BOM.csv writes Yes/No into a real `bit` column.
    mkdirSync(join(sampleRoot, 'ITBits'));
    writeFileSync(join(sampleRoot, 'ITBits', 'products.csv'), `${BITS_PRODUCTS_CSV}\n`);
    writeFileSync(join(sampleRoot, 'ITBits', 'BOM.csv'), `${BITS_BOM_CSV}\n`);

    // A set for a table no shipped set covers, found by its file name alone.
    mkdirSync(join(sampleRoot, 'ITDerived'));
    writeFileSync(join(sampleRoot, 'ITDerived', 'trackingServices.csv'), `${TRACKING_SERVICES_CSV}\n`);

    // A set with no CSVs at all, like the shipped SampleData/Test2.
    mkdirSync(join(sampleRoot, 'ITEmpty'));

    app = bootApp({ SAMPLE_DATA_DIR: sampleRoot, SCO_UPLOAD_CSV_DIR: STAGE_DIR });

    // Start from a known state even if a prior run was interrupted.
    await purge();
  });

  afterAll(async () => {
    await purge();
    rmSync(sampleRoot, { recursive: true, force: true });
    await app.close();
  });

  it('lists the fixture sets through the real app', async () => {
    const res = await fetch(`${app.base}/api/sample-data/folders`);
    expect(res.status).toBe(200);
    expect((await jsonOf<{ folders: string[] }>(res)).folders).toEqual([
      'ITBits',
      'ITDerived',
      'ITDupes',
      'ITEmpty',
      'ITGood',
      'ITMixed',
      'ITOrphan',
      'ITOrphanMixed',
    ]);
  });

  it('adds a whole set to the SC_Data tables, parents first, and creates NO table', async () => {
    const tablesBefore = await tableCount();
    const { status, body } = await load('ITGood');

    expect(status).toBe(200);
    expect(body.ok, JSON.stringify(body.tables)).toBe(true);
    expect(body.schema).toBe('SC_Data');
    // Every file found its table by name, and every row in it landed.
    expect(new Map((body.tables ?? []).map((t) => [t.table, t.rows]))).toEqual(
      new Map([
        ['Location', 3],
        ['Carrier', BIG_ROWS],
        ['Product', 2],
        ['Customer', 1],
        ['SalesOrder', 1],
        ['SalesOrderLine', 1],
        ['DemandPlan', 1],
      ]),
    );
    // The order is derived from the FOREIGN KEYs this namespace actually declares, not from
    // the directory's alphabetical listing (which would put salesOrderLines before
    // salesOrders and customers before locations). Asserted as CONSTRAINTS rather than one
    // fixed sequence: any order satisfying them is correct, and the constraints are what
    // the load actually depends on.
    const order = (body.tables ?? []).map((t) => t.table);
    const at = (table: string) => order.indexOf(table);
    expect(at('Location')).toBeLessThan(at('Customer'));
    expect(at('Location')).toBeLessThan(at('SalesOrder'));
    expect(at('Location')).toBeLessThan(at('DemandPlan'));
    expect(at('Customer')).toBeLessThan(at('SalesOrder'));
    expect(at('SalesOrder')).toBeLessThan(at('SalesOrderLine'));
    expect(at('Product')).toBeLessThan(at('SalesOrderLine'));
    expect(at('Product')).toBeLessThan(at('DemandPlan'));
    expect(body.totalRows).toBe(BIG_ROWS + 9);
    expect(body.totalSkippedRows).toBe(0);

    // Counted in IRIS, not taken from the response.
    expect(await ours('Location')).toBe(3);
    expect(await ours('Carrier')).toBe(BIG_ROWS);
    expect(await ours('SalesOrderLine')).toBe(1);
    // The SC_Data tables are the product's: the load must not add one of its own.
    expect(await tableCount()).toBe(tablesBefore);
  });

  it('deletes the staged CSV from inside IRIS afterwards', async () => {
    // The user's data must not be left lying in a temp file in their container.
    for (const table of ['Location', 'Carrier', 'SalesOrder']) {
      expect(fileExistsInIris(app.iris.native, `${STAGE_DIR}/sample-data/${table}.csv`), table).toBe(false);
    }
  });

  it('lands the awkward VALUES intact: quoted comma, quoted newline, unicode', async () => {
    const rows = await q<Record<string, string | null>>(
      'SELECT uid, name, city, coordinates, postalCode FROM SC_Data.Location ' +
        `WHERE uid LIKE '${UID}%' ORDER BY uid`,
    );
    expect(rows.map((r) => r.uid)).toEqual([`${UID}_LOC_1`, `${UID}_LOC_2`, `${UID}_LOC_3`]);

    // A comma inside a quoted field is ONE value, not an extra column.
    expect(rows[0]?.name).toBe('Plant, North');
    expect(rows[0]?.coordinates).toBe('52.03, 5.66');
    expect(rows[0]?.postalCode).toBe('6710');
    // Non-ASCII text round-trips…
    expect(rows[1]?.name).toBe('Éclair Hub');
    // …and a newline inside a quoted field stays inside the value.
    expect(rows[2]?.name).toBe('multi\nline');
    // A leading zero survives: postalCode is text, so 02451 is not 2451.
    expect(rows[2]?.postalCode).toBe('02451');
  });

  it('stores a BLANK cell as NULL rather than as a value it never had', async () => {
    // Asserted with IS NULL rather than from the response body: Atelier's
    // /action/query JSON renders a NULL string as "", so the JSON cannot tell NULL
    // from empty (measured 2026-09-07 on IRIS 2025.2). SQL is the only witness.
    const [row] = await q<Record<string, number | string>>(
      'SELECT CASE WHEN postalCode IS NULL THEN 1 ELSE 0 END AS zipNull ' +
        `FROM SC_Data.Location WHERE uid = '${UID}_LOC_2'`,
    );
    expect(Number(row?.zipNull)).toBe(1);

    const [order] = await q<Record<string, number | string>>(
      'SELECT CASE WHEN committedShipDate IS NULL THEN 1 ELSE 0 END AS blankDate, ' +
        'CASE WHEN requestedShipDate IS NULL THEN 1 ELSE 0 END AS filledDate ' +
        `FROM SC_Data.SalesOrder WHERE uid = '${UID}_SO_1'`,
    );
    // A blank date column must not become an epoch date a chart would plot.
    expect(Number(order?.blankDate)).toBe(1);
    expect(Number(order?.filledDate)).toBe(0);
  });

  it('parses a real timestamp into the timestamp column, microseconds and all', async () => {
    const [row] = await q<Record<string, number | string>>(
      "SELECT {fn YEAR(orderPlacedDate)} AS y, {fn MONTH(orderPlacedDate)} AS m, " +
        '{fn DAYOFMONTH(orderPlacedDate)} AS dd, orderValue AS v ' +
        `FROM SC_Data.SalesOrder WHERE uid = '${UID}_SO_1'`,
    );
    expect([Number(row?.y), Number(row?.m), Number(row?.dd)]).toEqual([2026, 1, 2]);
    // The decimal value is a number, not a truncated integer.
    expect(Number(row?.v)).toBe(100.5);
  });

  it('loads a file that OMITS a column the table has, leaving it NULL', async () => {
    // demandPlan.csv brings six of DemandPlan's columns and not `quantityUom`. A column the
    // file has no header for is simply not loaded — the file is not failed over it, and the
    // column is not filled with something it never said.
    const [row] = await q<Record<string, number | string>>(
      'SELECT timeFrameDays AS days, quantity AS qty, ' +
        '{fn MONTH(startDate)} AS m, CASE WHEN quantityUom IS NULL THEN 1 ELSE 0 END AS uomNull ' +
        `FROM SC_Data.DemandPlan WHERE uid = '${UID}_DP_1'`,
    );
    expect(Number(row?.days)).toBe(7);
    expect(Number(row?.qty)).toBe(42);
    expect(Number(row?.m)).toBe(2);
    expect(Number(row?.uomNull)).toBe(1);
  });

  it('keeps the FOREIGN KEY references pointing at the rows it just loaded', async () => {
    // The order really joins back to its customer, location and product — which is
    // what loading parents first is for.
    const [row] = await q<Record<string, string | number>>(
      'SELECT c.name AS customer, l.city AS shipTo, p.name AS product, sol.quantity AS qty ' +
        'FROM SC_Data.SalesOrderLine sol ' +
        'JOIN SC_Data.SalesOrder so ON so.uid = sol.salesOrderId ' +
        'JOIN SC_Data.Customer c ON c.uid = so.customerId ' +
        'JOIN SC_Data.Location l ON l.uid = so.shipToLocationId ' +
        'JOIN SC_Data.Product p ON p.uid = sol.productId ' +
        `WHERE sol.uid = '${UID}_SOL_1'`,
    );
    expect(row?.customer).toBe('Acme Retail');
    expect(row?.shipTo).toBe('Ede');
    expect(row?.product).toBe('Widget');
    expect(Number(row?.qty)).toBe(5);
  });

  it('puts every value in the column its HEADER named, whatever order the file used', async () => {
    // customers.csv is written primaryLocationId,Status,Name,Type,uid,… A positional load
    // would be silently wrong here rather than failing: no constraint in SC_Data
    // objects to a type of "Active" or a uid that is really a location id.
    const [row] = await q<Record<string, string | null>>(
      'SELECT uid, name, type, status, primaryLocationId AS loc FROM SC_Data.Customer ' +
        `WHERE uid = '${UID}_CUS_1'`,
    );
    expect([row?.name, row?.type, row?.status, row?.loc]).toEqual([
      'Acme Retail',
      'Retail',
      'Active',
      `${UID}_LOC_1`,
    ]);
  });

  it('loads a column no example set uses, because the SC_Data table really has it', async () => {
    // locations.csv here carries Region and Latitude — real Location columns, spelled with a
    // different case from the column's — plus a Nonsense column the table does not have. The
    // two real ones must be in the table; the third must have been ignored rather than
    // failing the file (the whole set loaded above, which is that half of the proof).
    const rows = await q<Record<string, string | null>>(
      `SELECT uid, region, latitude FROM SC_Data.Location WHERE uid LIKE '${UID}%' ORDER BY uid`,
    );
    expect(rows.map((r) => [r.region, r.latitude])).toEqual([
      ['EMEA', '52.03'],
      ['EMEA', '48.85'],
      ['AMER', '42.39'],
    ]);

    // Same thing on another table, from a header whose case differs from the column's.
    const [customer] = await q<Record<string, string | null>>(
      `SELECT url FROM SC_Data.Customer WHERE uid = '${UID}_CUS_1'`,
    );
    expect(customer?.url).toBe('https://acme.example');
  });

  it('REPORTS the header that went nowhere, on the set that loaded whole', async () => {
    // The other half of the proof above: `Nonsense` was ignored, and the user is told so
    // rather than left to notice the missing values themselves. `ID` is named too — it is
    // a real Customer column, but the identity one, which a load must never write.
    const { body } = await load('ITGood');
    const ignored = new Map(
      (body.tables ?? []).map((t) => [t.file, t.ignoredHeaders ?? []] as const),
    );
    expect(ignored.get('locations.csv')).toEqual(['Nonsense']);
    expect(ignored.get('customers.csv')).toEqual(['ID']);
    // Nothing invented for the files whose every header found a column.
    expect(ignored.get('carriers.csv')).toEqual([]);
    expect(body.totalIgnoredHeaders).toBe(2);
  });

  it('leaves the IDENTITY column to IRIS even when the CSV carries an ID of its own', async () => {
    // customers.csv holds both `uid` (the key) and `ID` = 999999 (the row id an export
    // carries). The key must be the uid, and the row id must be the one
    // $i(^SC.Data.CustomerD) assigned — writing the file's would collide with the
    // instance's own counter.
    const [row] = await q<Record<string, string | number>>(
      `SELECT ID AS rowId, uid FROM SC_Data.Customer WHERE uid = '${UID}_CUS_1'`,
    );
    expect(row?.uid).toBe(`${UID}_CUS_1`);
    expect(Number(row?.rowId)).toBeGreaterThan(0);
    expect(Number(row?.rowId)).not.toBe(999999);
    // And nothing landed under the row id as a key.
    const [stray] = await q<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM SC_Data.Customer WHERE uid = '999999'",
    );
    expect(Number(stray?.n)).toBe(0);
  });

  it('loads a file bigger than one uid-probe chunk without losing or repeating a row', async () => {
    const [row] = await q<{ n: number | string; distinctNames: number | string }>(
      // `names` cannot be the alias: it is a reserved word in IRIS SQL (SQLCODE -1).
      'SELECT COUNT(*) AS n, COUNT(DISTINCT name) AS distinctNames FROM SC_Data.Carrier ' +
        `WHERE uid LIKE '${UID}_CAR_%'`,
    );
    expect(Number(row?.n)).toBe(BIG_ROWS);
    // Every name distinct, so no chunk was sent twice.
    expect(Number(row?.distinctNames)).toBe(BIG_ROWS);
  });

  it('is REPEATABLE: a second load adds nothing and reports the skipped rows', async () => {
    // The user's rule, on real data: "if a UID exists ignore that row and continue
    // with the others". Doubling here would corrupt their tables.
    const { status, body } = await load('ITGood');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.totalRows).toBe(0);
    expect(body.totalSkippedRows).toBe(BIG_ROWS + 9);
    expect(body.tables?.every((t) => t.rows === 0)).toBe(true);
    expect(await ours('Location')).toBe(3);
    expect(await ours('Carrier')).toBe(BIG_ROWS);
    expect(await ours('SalesOrderLine')).toBe(1);

    // The FIRST load's values are the ones that stayed — nothing was overwritten.
    const [row] = await q<{ name: string }>(
      `SELECT name FROM SC_Data.Location WHERE uid = '${UID}_LOC_1'`,
    );
    expect(row?.name).toBe('Plant, North');
  });

  it('skips a repeated uid and a blank one, keeping the FIRST of the duplicates', async () => {
    const { status, body } = await load('ITDupes');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tables?.[0]).toMatchObject({ table: 'Carrier', rows: 2, skippedRows: 2 });
    expect(body.totalRows).toBe(2);

    const rows = await q<{ uid: string; name: string }>(
      `SELECT uid, name FROM SC_Data.Carrier WHERE uid LIKE '${UID}_CAR_DUP' OR uid LIKE '${UID}_CAR_NEW' ORDER BY uid`,
    );
    expect(rows.map((r) => [r.uid, r.name])).toEqual([
      [`${UID}_CAR_DUP`, 'First'],
      [`${UID}_CAR_NEW`, 'Fresh'],
    ]);
  });

  it('loads the good file, fails the keyless one, and SKIPS the one no table takes', async () => {
    const { status, body } = await load('ITMixed');

    expect(status).toBe(200);
    expect(body.ok).toBe(false); // one file genuinely failed
    // Nothing here has a foreign key the set brings, so the order is the caller's own
    // (alphabetical) — a set with nothing to order by is not reordered.
    expect(body.tables?.map((t) => [t.file, t.ok, t.skipped ?? false])).toEqual([
      ['notes.csv', true, true],
      ['products.csv', true, false],
      ['suppliers.csv', false, false],
    ]);
    expect(body.tables?.[0]?.reason).toMatch(/No SC_Data table takes notes\.csv/);
    expect(body.tables?.[2]?.error).toMatch(/suppliers\.csv has no UID or ID column/);
    expect(body.totalRows).toBe(1);

    // The good row landed; the keyless file wrote nothing at all.
    expect(await ours('Product')).toBe(3);
    expect(await ours('Supplier')).toBe(0);
  });

  it('LEAVES OUT a row whose FOREIGN KEY parent is not in this namespace, and says which', async () => {
    // The bug report, reproduced against the real constraint: a set with no
    // locations.csv. IRIS would take ~57 s per 1,000 such rows to reject them all and
    // still answer "Complete", which is what timed the page out. The row is dropped
    // before the load instead, so this returns quickly and explains itself.
    const started = Date.now();
    const { status, body } = await load('ITOrphan');
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect(body.ok).toBe(true); // reported, not a failure
    expect(body.totalRows).toBe(0);
    expect(body.totalOrphanRows).toBe(1);
    expect(body.tables?.[0]).toMatchObject({
      file: 'customers.csv',
      table: 'Customer',
      ok: true,
      rows: 0,
      orphanRows: 1,
    });
    // The reason names the table the user has to load first, and the column.
    expect(body.tables?.[0]?.orphanReason).toContain('SC_Data.Location');
    expect(body.tables?.[0]?.orphanReason).toContain('primaryLocationId');

    // Nothing reached the table, and no half-row was left behind.
    const [row] = await q<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM SC_Data.Customer WHERE uid = '${UID}_CUS_ORPHAN'`,
    );
    expect(Number(row?.n)).toBe(0);
    // The whole point of pre-flighting: this is a fast answer, not a 30 s timeout.
    expect(elapsed).toBeLessThan(25_000);
  });

  it('loads the sibling row whose parent the set DOES bring, in the same file', async () => {
    // Proof the pre-flight is per row, not per file: one customer's location is in the
    // set (loaded first, parents first), the other's is nowhere.
    const { status, body } = await load('ITOrphanMixed');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.totalRows).toBe(2); // the location plus the customer that can point at it
    expect(body.totalOrphanRows).toBe(1);
    expect(body.tables?.map((t) => [t.table, t.rows, t.orphanRows])).toEqual([
      ['Location', 1, 0],
      ['Customer', 1, 1],
    ]);

    // Read back through the FOREIGN KEY itself: the row that landed really joins.
    const rows = await q<{ uid: string; locname: string }>(
      'SELECT c.uid AS uid, l.name AS locname FROM SC_Data.Customer c ' +
        `JOIN SC_Data.Location l ON l.uid = c.primaryLocationId WHERE c.uid LIKE '${UID}_CUS_%' ` +
        'ORDER BY c.uid',
    );
    expect(rows.map((r) => [r.uid, r.locname])).toContainEqual([`${UID}_CUS_OK`, 'Ninth Depot']);
    expect(rows.map((r) => r.uid)).not.toContain(`${UID}_CUS_GONE`);
  });

  it('puts Yes/No into a real `bit` column as 1/0, and leaves a VARCHAR "No" alone', async () => {
    // The BOM.csv 504, reproduced against the real `bit`: unconverted, IRIS rejects every
    // row ("Field 'SC_Data.BOM.isAlternate' (value 'No') failed validation") one message
    // at a time, which is what made the gateway give up on the shipped 5,103-row file.
    const { status, body } = await load('ITBits');

    expect(status).toBe(200);
    expect(body.ok, JSON.stringify(body.tables)).toBe(true);
    // Parents first: the BOM rows all point at the product this set brings.
    expect(body.tables?.map((t) => [t.table, t.rows])).toEqual([
      ['Product', 1],
      ['BOM', 4],
    ]);

    const rows = await q<{ uid: string; isalt: unknown; uom: string }>(
      'SELECT uid, isAlternate AS isalt, unitOfMeasure AS uom ' +
        `FROM SC_Data.BOM WHERE uid LIKE '${UID}_BOM_%' ORDER BY uid`,
    );
    expect(rows.map((r) => [r.uid, r.isalt, r.uom])).toEqual([
      // A blank cell is staged empty, as for any other column — and IRIS's own
      // `LOAD DATA` stores 0 in a `bit`, not NULL, even though the column is nullable.
      [`${UID}_BOM_BLANK`, false, 'EACH'],
      // `No` in the bit column became 0, while `No` in the VARCHAR beside it did not.
      [`${UID}_BOM_NO`, false, 'No'],
      [`${UID}_BOM_TRUE`, true, 'EACH'],
      [`${UID}_BOM_YES`, true, 'No'],
    ]);
  });

  it('LOADS a table no example set covers, found from the file name alone', async () => {
    // The generic path, end to end on the real instance: nothing in this repo mentions
    // trackingServices.csv or SC_Data.TrackingService. If either needed an entry somewhere,
    // every new example file would be a code change — which is the thing being ruled out.
    const { status, body } = await load('ITDerived');

    expect(status).toBe(200);
    expect(body.ok, JSON.stringify(body.tables)).toBe(true);
    expect(body.tables?.[0]).toMatchObject({
      file: 'trackingServices.csv',
      table: 'TrackingService',
      ok: true,
      rows: 2,
      skippedRows: 0,
      orphanRows: 0,
      // The uid plus the six columns the file names — every one of them matched against the
      // TABLE's own column names, because there is nowhere else they could come from.
      columns: 7,
    });
    // And the one header that fits no column is REPORTED, not silently dropped.
    expect(body.tables?.[0]?.ignoredHeaders).toEqual(['Nonsense']);
    expect(body.totalIgnoredHeaders).toBe(1);

    const rows = await q<Record<string, unknown>>(
      'SELECT uid, trackingServiceProvider AS provider, stopSequencingRequired AS seq, ' +
        'maximumAllowableDrivingHoursPerDay AS hours, {fn MONTH(startDate)} AS m, ' +
        'CASE WHEN endDate IS NULL THEN 1 ELSE 0 END AS endNull ' +
        `FROM SC_Data.TrackingService WHERE uid LIKE '${UID}_TRK_%' ORDER BY uid`,
    );
    // `Yes`/`No` reached the `bit` column as 1/0 — the coercion is driven by the type IRIS
    // reports, so it works for a table nothing here describes just as it does for BOM.
    expect(rows.map((r) => [r.uid, r.seq, Number(r.hours), Number(r.m), Number(r.endNull)])).toEqual([
      [`${UID}_TRK_1`, true, 11.5, 3, 0],
      [`${UID}_TRK_2`, false, 9, 4, 1],
    ]);
    expect(rows[0]?.provider).toBe('FleetEye');
  });

  it('MATCHES THE INSTALLED SCHEMA: every fixture names a real table and real columns', async () => {
    // The loader takes the naming guarantee on trust — a file name IS its table's name and a
    // header IS its column's name — so the fixtures above are only meaningful if they really
    // are written that way. Checked here against the live schema, because a fixture that
    // silently stopped matching would not FAIL: it would load fewer columns, or none, and
    // the assertions above would still pass on whatever did land. That is the same silence an
    // SCO upgrade renaming a column would cause on a real set, which is why the loader
    // reports its leftovers and why this test states which fixtures rely on that.
    const rows = await q<Record<string, string>>(
      'SELECT TABLE_NAME, COLUMN_NAME, IS_IDENTITY, IS_GENERATED, IS_UPDATABLE ' +
        "FROM INFORMATION_SCHEMA.COLUMNS WHERE UPPER(TABLE_SCHEMA) = 'SC_DATA'",
    );
    const writable = new Map<string, Set<string>>();
    /** Lowercased table name → the way SC_Data declares it, for readable messages. */
    const declared = new Map<string, string>();
    for (const row of rows) {
      const table = String(row.TABLE_NAME ?? '').toLowerCase();
      const column = String(row.COLUMN_NAME ?? '').toLowerCase();
      if (!table || !column) continue;
      declared.set(table, String(row.TABLE_NAME));
      const is = (value: string | undefined, want: string) =>
        String(value ?? '').trim().toUpperCase() === want;
      const held = writable.get(table) ?? new Set<string>();
      // Only the columns a load may WRITE count: a header naming the identity `ID` or a
      // generated timestamp is dropped at load time, which is the same silence.
      if (!is(row.IS_IDENTITY, 'YES') && !is(row.IS_GENERATED, 'YES') && !is(row.IS_UPDATABLE, 'NO')) {
        held.add(column);
      }
      writable.set(table, held);
    }
    const installed = [...declared.values()];
    expect(installed.length, 'SC_Data is not installed in this namespace').toBeGreaterThan(10);

    /** The one fixture file that names no table ON PURPOSE, and is asserted as skipped. */
    const NO_TABLE = new Set(['notes.csv']);
    /** The one header that matches no column ON PURPOSE, and is asserted as reported. */
    const NO_COLUMN = new Set(['nonsense']);

    // Collected rather than asserted one at a time, so a rename shows every fixture it
    // affected instead of just the first.
    const problems: string[] = [];
    for (const set of readdirSync(sampleRoot, { withFileTypes: true })) {
      if (!set.isDirectory()) continue;
      for (const file of readdirSync(join(sampleRoot, set.name))) {
        if (!file.toLowerCase().endsWith('.csv')) continue;
        const where = `${set.name}/${file}`;
        const table = resolveScDataTable(file, installed);
        if (!table) {
          if (!NO_TABLE.has(file)) problems.push(`${where} matches no installed SC_Data table`);
          continue;
        }
        const columns = writable.get(table.toLowerCase()) ?? new Set<string>();
        const header = readFileSync(join(sampleRoot, set.name, file), 'utf8').split(/\r?\n/)[0] ?? '';
        for (const raw of header.split(',')) {
          const name = raw.trim();
          const key = name.toLowerCase();
          if (!key || NO_COLUMN.has(key)) continue;
          // The key is the one header that is an alias rather than a column name.
          if (KEY_HEADERS.some((k) => k.toLowerCase() === key)) continue;
          if (!columns.has(key)) {
            problems.push(`SC_Data.${table}.${name} (${where}) is not a writable column`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('reports a set with no CSV files as ok:false, having loaded nothing', async () => {
    const { status, body } = await load('ITEmpty');
    expect(status).toBe(200);
    expect(body).toMatchObject({ folder: 'ITEmpty', tables: [], totalRows: 0, ok: false });
  });

  it('404s an unknown set and a traversal attempt, leaving IRIS untouched', async () => {
    // A CSV that exists OUTSIDE any set, which a traversal would load.
    writeFileSync(join(sampleRoot, 'carriers.csv'), `ID,Name,Type,Status\n${UID}_CAR_LEAK,Leak,Road,Active\n`);

    for (const folder of ['Nope', '..', '../..', 'ITGood/..', '/etc', 'ITGood/nested']) {
      const { status, body } = await load(folder);
      expect(status, String(folder)).toBe(404);
      expect(body.code).toBe('NOT_FOUND');
    }

    const [row] = await q<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM SC_Data.Carrier WHERE uid = '${UID}_CAR_LEAK'`,
    );
    expect(Number(row?.n)).toBe(0);
  });

  it('400s a request that does not name a set', async () => {
    for (const folder of [undefined, '', '   ', 42]) {
      const { status, body } = await load(folder);
      expect(status, String(folder)).toBe(400);
      expect(body.code).toBe('VALIDATION');
    }
  });

  // ---- the tables a set would populate, read from the LIVE schema ------------

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

  async function tablesOf(folder: unknown): Promise<{ status: number; body: PreviewBody }> {
    const res = await fetch(
      `${app.base}/api/sample-data/tables?folder=${encodeURIComponent(String(folder))}`,
    );
    return { status: res.status, body: await jsonOf<PreviewBody>(res) };
  }

  it('names the REAL SC_Data tables a set would populate, and writes nothing', async () => {
    // Against the installed model, not a fixture list: each file is matched to a table
    // this namespace actually has, and the order comes from its real FOREIGN KEYs.
    const before = await Promise.all(TOUCHED.map(ours));
    const tables = await tableCount();

    const { status, body } = await tablesOf('ITGood');

    expect(status).toBe(200);
    expect(body).toMatchObject({ folder: 'ITGood', schema: 'SC_Data', verified: true });
    expect(body.tables?.map((t) => t.table)).toEqual(
      expect.arrayContaining([
        'Location',
        'Carrier',
        'Product',
        'Customer',
        'SalesOrder',
        'SalesOrderLine',
        'DemandPlan',
      ]),
    );
    expect(body.tables?.every((t) => t.willLoad)).toBe(true);
    // Parents before children, as the load itself would go.
    const at = (table: string) => (body.tables ?? []).findIndex((t) => t.table === table);
    expect(at('Location')).toBeLessThan(at('Customer'));
    expect(at('Customer')).toBeLessThan(at('SalesOrder'));
    expect(at('SalesOrder')).toBeLessThan(at('SalesOrderLine'));
    expect(at('Product')).toBeLessThan(at('DemandPlan'));

    // A dropdown change must not write to the user's tables: not one row, not one table,
    // and nothing left behind inside IRIS.
    expect(await Promise.all(TOUCHED.map(ours))).toEqual(before);
    expect(await tableCount()).toBe(tables);
    expect(fileExistsInIris(app.iris.native, `${STAGE_DIR}/sample-data/Location.csv`)).toBe(false);
  });

  it('agrees with the load it describes, including the file no table takes', async () => {
    // Preview and load resolve and order through the same code; if they ever disagreed,
    // the list the user reads before pressing Load would be describing something else.
    const preview = await tablesOf('ITMixed');
    const loaded = await load('ITMixed');

    expect(preview.body.tables?.map((t) => [t.file, t.table])).toEqual(
      loaded.body.tables?.map((t) => [t.file, t.table]),
    );
    expect(preview.body.tables?.map((t) => t.willLoad)).toEqual(
      loaded.body.tables?.map((t) => t.skipped !== true),
    );
    // notes.csv names no SC_Data table in this namespace, so it is flagged, not omitted.
    expect(preview.body.tables).toEqual(
      expect.arrayContaining([{ file: 'notes.csv', table: 'notes', willLoad: false }]),
    );
  });

  it('reads the set\'s own intro.txt beside the tables, and never loads it', async () => {
    const preview = await tablesOf('ITGood');

    // The file's CRLFs and trailing blank line are normalized, its line break kept.
    expect(preview.body.intro).toBe(
      'This is a dataset for development purpose.\nThis will load 7 files.',
    );
    // And it stays a description: no table is asked to take it, in the preview or the
    // load — a set with a description must not report a skipped file for having one.
    expect(preview.body.tables?.map((t) => t.file)).not.toContain('intro.txt');
    const loaded = await load('ITGood');
    expect(loaded.body.tables?.map((t) => t.file)).not.toContain('intro.txt');
  });

  it('answers an empty set with an empty list, and refuses an unknown or escaping name', async () => {
    const empty = await tablesOf('ITEmpty');
    expect(empty.status).toBe(200);
    // A set with no description says nothing rather than sending an empty one.
    expect(empty.body.intro).toBeUndefined();
    expect(empty.body).toMatchObject({ folder: 'ITEmpty', tables: [], verified: true });

    for (const folder of ['Nope', '..', '../..', 'ITGood/..', '/etc']) {
      const { status, body } = await tablesOf(folder);
      expect(status, String(folder)).toBe(404);
      expect(body.code).toBe('NOT_FOUND');
      expect(body.tables).toBeUndefined();
    }

    const res = await fetch(`${app.base}/api/sample-data/tables`);
    expect(res.status).toBe(400);
    expect((await jsonOf<PreviewBody>(res)).code).toBe('VALIDATION');
  });
});
