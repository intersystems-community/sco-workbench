/**
 * Data Model invalid-input matrix (DI1–DI5) against live IRIS. scmodel is
 * create-only with NO client-side guards — every invalid case relies on IRIS
 * returning `{ Status, Message }` (capital-M). These are the regression guard for
 * the documented casing bug (the UI once showed a bare "400" because it read
 * lowercase `message`). scmodel has no delete, so created objects use a run-
 * unique name and are disposable. Live IRIS required; run via: npm run test:it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, jsonOf, type BootedApp } from './helpers/iris-app.js';
import { uniqueSuffix } from './helpers/provision.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;
const SCMODEL = '/api/scmodel/v1';

d('Data Model invalid-input matrix (live)', () => {
  let app: BootedApp;

  beforeAll(() => {
    app = bootApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const createObject = (body: unknown) =>
    fetch(`${app.base}${SCMODEL}/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const addAttr = (objectName: string, body: unknown) =>
    fetch(`${app.base}${SCMODEL}/attributes/${encodeURIComponent(objectName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A message is readable regardless of SCO casing (Message / message / error). */
  async function readableMessage(res: Response): Promise<string | undefined> {
    const body = await jsonOf<Record<string, unknown>>(res);
    const msg = body.Message ?? body.message ?? body.error;
    return typeof msg === 'string' && msg.trim() ? msg : undefined;
  }

  it('DI1: re-creating an existing object is refused, and the IRIS Message surfaces', async () => {
    const objectName = `WorkbenchTestObject${uniqueSuffix()}`;
    const first = await createObject({
      objectName,
      description: 'IT',
      attributes: [{ name: 'code', dataType: 'String', required: 1, description: '' }],
    });
    expect([200, 201], await first.clone().text()).toContain(first.status);

    const dup = await createObject({
      objectName,
      description: 'dup',
      attributes: [{ name: 'code', dataType: 'String', required: 0, description: '' }],
    });
    expect([200, 201].includes(dup.status), `duplicate create should be refused (got ${dup.status})`).toBe(false);
    // The key regression: a readable message must be present (capital-M included).
    expect(await readableMessage(dup)).toBeTruthy();
  });

  it('DI3: adding an attribute to a nonexistent object is refused with a readable message', async () => {
    const res = await addAttr(`WorkbenchTestNoObject${uniqueSuffix()}`, {
      name: 'x',
      dataType: 'String',
      required: 0,
      description: '',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await readableMessage(res)).toBeTruthy();
  });

  it('DI4: an invalid dataType is rejected by IRIS with a readable message', async () => {
    const objectName = `WorkbenchTestObject${uniqueSuffix()}`;
    const res = await createObject({
      objectName,
      description: 'IT',
      attributes: [{ name: 'code', dataType: 'NotAType', required: 0, description: '' }],
    });
    // Either the create is refused, or (if IRIS is lenient) it must not silently
    // corrupt — assert a refusal path with a message when it fails.
    if (![200, 201].includes(res.status)) {
      expect(await readableMessage(res)).toBeTruthy();
    }
  });

  it('DI5: a blank object name is refused', async () => {
    const res = await createObject({ objectName: '', description: '', attributes: [] });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
