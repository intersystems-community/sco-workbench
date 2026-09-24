/**
 * Schema introspection (S1–S5) against the DEFAULT SCO data model — read-only,
 * non-invasive, no provisioning needed. Uses the shipped `SC.Data.SalesOrder`.
 *
 * Live IRIS required; run via: npm run test:it
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, type BootedApp } from './helpers/iris-app.js';
import { resolveClass, listProperties, listMethods, matchProperty } from '../../src/iris/schema-ops.js';

// Live IRIS required; run via the path-scoped script: npm run test:it
const d = describe;

d('schema introspection (live)', () => {
  let app: BootedApp;

  beforeAll(() => {
    app = bootApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('S1: resolves the SQL table name to the ObjectScript class', async () => {
    const resolved = await resolveClass(app.iris.atelier, 'SC_Data.SalesOrder');
    expect(resolved.exists, JSON.stringify(resolved)).toBe(true);
    expect(resolved.className).toBe('SC.Data.SalesOrder');
  });

  it('S2: lists real (case-exact) property names', async () => {
    const props = await listProperties(app.iris.atelier, 'SC.Data.SalesOrder');
    const names = props.map((p) => p.name);
    expect(names).toContain('orderValue');
    expect(names).toContain('customerId');
    expect(names).not.toContain('OrderValue'); // wrong case is not a real property
  });

  it('S3: a typo/wrong-case resolves to the closest match', async () => {
    const m = await matchProperty(app.iris.atelier, 'SC.Data.SalesOrder', 'OrderVale');
    expect(m.exact).toBeUndefined();
    expect(m.closest[0]?.name).toBe('orderValue');
  });

  it('S4: an unknown class does not resolve and returns candidates', async () => {
    const resolved = await resolveClass(app.iris.atelier, 'SC.Data.NoSuchClass');
    expect(resolved.exists).toBe(false);
    expect(Array.isArray(resolved.candidates)).toBe(true);
  });

  it('S5: lists methods of a default SCO class', async () => {
    const methods = await listMethods(app.iris.atelier, 'SC.Data.SalesOrder');
    expect(Array.isArray(methods)).toBe(true);
    expect(methods.length).toBeGreaterThan(0);
  });
});
