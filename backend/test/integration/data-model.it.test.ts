/**
 * Data Model (scmodel, create-only) + row counts (D1–D8) against a live, clean
 * IRIS. Row-count tests seed their own source (tables may be empty on a clean
 * instance). scmodel has NO delete API, so created objects use a run-unique name
 * and are documented as disposable. Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { seedSource, runCleanups, uniqueSuffix, type Cleanup } from './helpers/provision.js';
import { sweep } from './helpers/sweep.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;
const SCMODEL = '/api/scmodel/v1';

d('Data Model + row counts (live)', () => {
  let app: BootedApp;
  let cleanups: Cleanup[] = [];

  beforeAll(() => {
    app = bootApp();
  });

  afterAll(async () => {
    await sweep(app.iris);
    await app.close();
  });

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    await runCleanups(cleanups);
  });

  it('D1: lists objects — default SCO objects present with a className', async () => {
    const res = await fetch(`${app.base}${SCMODEL}/objects`);
    expect(res.status, await res.clone().text()).toBe(200);
    const objects = await jsonOf<Array<{ objectName: string; className: string }>>(res);
    expect(Array.isArray(objects)).toBe(true);
    const salesOrder = objects.find((o) => o.objectName === 'SalesOrder');
    expect(salesOrder, 'SalesOrder object listed').toBeTruthy();
  });

  it('D2: object detail returns attributes (structure, not row data)', async () => {
    const detail = await jsonOf<{ objectName: string; attributes: Array<{ name: string; dataType: string }> }>(
      await fetch(`${app.base}${SCMODEL}/objects/SalesOrder`),
    );
    expect(detail.objectName).toBe('SalesOrder');
    expect(Array.isArray(detail.attributes)).toBe(true);
    expect(detail.attributes.length).toBeGreaterThan(0);
  });

  it('D3/D4: create a custom object + initial attribute, then add another', async () => {
    const objectName = `WorkbenchTestObject${uniqueSuffix()}`;
    const created = await fetch(`${app.base}${SCMODEL}/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objectName,
        description: 'IT custom object',
        attributes: [{ name: 'code', dataType: 'String', required: 1, description: 'A code' }],
      }),
    });
    expect([200, 201], await created.clone().text()).toContain(created.status);

    const list = await jsonOf<Array<{ objectName: string }>>(await fetch(`${app.base}${SCMODEL}/objects`));
    expect(list.some((o) => o.objectName === objectName)).toBe(true);

    const addAttr = await fetch(`${app.base}${SCMODEL}/attributes/${encodeURIComponent(objectName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'amount', dataType: 'Numeric', required: 0, description: 'An amount' }),
    });
    expect([200, 201], await addAttr.clone().text()).toContain(addAttr.status);

    const after = await jsonOf<{ attributes: Array<{ name: string }> }>(
      await fetch(`${app.base}${SCMODEL}/objects/${objectName}`),
    );
    expect(after.attributes.some((a) => a.name === 'amount')).toBe(true);
  });

  it('D6: row count on a seeded source returns the exact total', async () => {
    const src = await seedSource(app.iris, { seedRows: true });
    cleanups.push(src.cleanup);
    const res = await fetch(`${app.base}/api/data-browser/${src.className}/count`);
    expect(res.status).toBe(200);
    const body = await jsonOf<{ total: number }>(res);
    expect(body.total).toBe(src.rowCount);
  });

  it('D7: row count on an EMPTY seeded source returns 0', async () => {
    const src = await seedSource(app.iris, { seedRows: false });
    cleanups.push(src.cleanup);
    const res = await fetch(`${app.base}/api/data-browser/${src.className}/count`);
    expect(res.status).toBe(200);
    const body = await jsonOf<{ total: number }>(res);
    expect(body.total).toBe(0);
  });

  it('D8: row count on an unknown class → 404 with candidates + code', async () => {
    const res = await fetch(`${app.base}/api/data-browser/SC.Data.NoSuchClassXYZ/count`);
    expect(res.status).toBe(404);
    const body = await jsonOf<{ code: string; candidates: string[] }>(res);
    expect(body.code).toBe('NOT_FOUND');
    expect(Array.isArray(body.candidates)).toBe(true);
  });
});
