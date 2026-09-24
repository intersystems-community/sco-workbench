import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDatabase } from '../../src/db/sqlite.js';
import { KpiDraftRepository, type KpiDraft } from '../../src/db/kpi-drafts.js';
import { createKpiDraftRouter } from '../../src/server/kpi-draft-routes.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import type { KpiDefinition } from '../../src/kpi/kpi-definition.model.js';
import type Database from 'better-sqlite3';

function sampleKpi(name: string, cube = 'SalesCube'): KpiDefinition {
  return {
    name,
    label: `${name} label`,
    type: 'DeepSee',
    baseObject: 'SalesOrder',
    status: 'Active',
    issueKpi: true,
    defaultIssueSeverity: 2,
    deepseeKpiSpec: {
      namespace: 'SC',
      cube,
      kpiMeasure: '%COUNT',
      valueType: 'raw',
      kpiConditions: ['[status].[H1].[status].&[Open]'],
      kpiDimensions: [{ name: 'region', label: 'Region', cubeDimension: '[region].[H1].[name]' }],
    },
  };
}

// ── Repository ────────────────────────────────────────────────
describe('KpiDraftRepository', () => {
  let db: Database.Database;
  let repo: KpiDraftRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new KpiDraftRepository(db);
  });

  afterEach(() => db.close());

  it('upserts and reads back a draft with its full definition', () => {
    const saved = repo.upsert('MyKpi', sampleKpi('MyKpi'), 'draft');
    expect(saved.kpiName).toBe('MyKpi');
    expect(saved.state).toBe('draft');

    const got = repo.get('MyKpi');
    expect(got?.definition.deepseeKpiSpec?.cube).toBe('SalesCube');
    expect(got?.definition.issueKpi).toBe(true);
    expect(got?.definition.defaultIssueSeverity).toBe(2);
  });

  it('upsert overwrites the prior definition + state for the same name', () => {
    repo.upsert('MyKpi', sampleKpi('MyKpi', 'CubeA'), 'draft');
    repo.upsert('MyKpi', sampleKpi('MyKpi', 'CubeB'), 'created');
    const got = repo.get('MyKpi');
    expect(got?.definition.deepseeKpiSpec?.cube).toBe('CubeB');
    expect(got?.state).toBe('created');
    expect(repo.list()).toHaveLength(1);
  });

  it('lists drafts ordered by name and deletes by name', () => {
    repo.upsert('Bravo', sampleKpi('Bravo'), 'draft');
    repo.upsert('Alpha', sampleKpi('Alpha'), 'draft');
    expect(repo.list().map((d: KpiDraft) => d.kpiName)).toEqual(['Alpha', 'Bravo']);

    repo.delete('Alpha');
    expect(repo.list().map((d: KpiDraft) => d.kpiName)).toEqual(['Bravo']);
  });

  it('returns null for an unknown name', () => {
    expect(repo.get('Nope')).toBeNull();
  });

  it('does not mutate the input definition on upsert', () => {
    const def = sampleKpi('MyKpi');
    const before = JSON.stringify(def);
    repo.upsert('MyKpi', def, 'draft');
    expect(JSON.stringify(def)).toBe(before);
  });
});

// ── Router ────────────────────────────────────────────────────
describe('createKpiDraftRouter', () => {
  let db: Database.Database;
  let app: Express;
  let server: Server;
  let baseUrl: string;

  // Minimal fake IrisServices: only `atelier.query` is used (by /base-objects).
  const fakeIris = {
    atelier: {
      query: async () => [
        { Name: 'SC.Core.API.Data.SalesOrderApiImpl' },
        { Name: 'SC.Core.API.Data.SupplyShipmentApiImpl' },
        { Name: 'SC.Other.NotAnApiImpl' }, // filtered out (wrong prefix)
      ],
    },
  } as unknown as Parameters<typeof createKpiDraftRouter>[1];

  beforeEach(async () => {
    db = openDatabase(':memory:');
    app = express();
    app.use(express.json());
    app.use('/api/kpi-drafts', createKpiDraftRouter(new KpiDraftRepository(db), fakeIris));
    app.use(errorEnvelope(false));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('saves a draft and lists it', async () => {
    const save = await fetch(`${baseUrl}/api/kpi-drafts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: sampleKpi('MyKpi') }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ ok: true, kpiName: 'MyKpi', state: 'draft' });

    const list: any = await (await fetch(`${baseUrl}/api/kpi-drafts`)).json();
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0].kpiName).toBe('MyKpi');
  });

  it('lists KPI base objects, stripping the SC.Core.API.Data.*ApiImpl wrapper', async () => {
    const res = await fetch(`${baseUrl}/api/kpi-drafts/base-objects`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.baseObjects).toEqual(['SalesOrder', 'SupplyShipment']);
  });

  it('rejects a save without a name', async () => {
    const res = await fetch(`${baseUrl}/api/kpi-drafts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: { label: 'no name' } }),
    });
    expect(res.status).toBe(400);
  });

  it('a rename drops the old draft so the list has no duplicate', async () => {
    await fetch(`${baseUrl}/api/kpi-drafts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: sampleKpi('OldName') }),
    });
    await fetch(`${baseUrl}/api/kpi-drafts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: sampleKpi('NewName'), originalName: 'OldName' }),
    });
    const list: any = await (await fetch(`${baseUrl}/api/kpi-drafts`)).json();
    expect(list.drafts.map((d: KpiDraft) => d.kpiName)).toEqual(['NewName']);
  });

  it('deletes a draft', async () => {
    await fetch(`${baseUrl}/api/kpi-drafts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: sampleKpi('MyKpi') }),
    });
    const del = await fetch(`${baseUrl}/api/kpi-drafts/MyKpi`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list: any = await (await fetch(`${baseUrl}/api/kpi-drafts`)).json();
    expect(list.drafts).toHaveLength(0);
  });
});
