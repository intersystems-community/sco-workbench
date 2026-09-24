import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/sqlite.js';
import { DashboardRepository } from '../../src/db/dashboards.js';
import { emptyDashboardConfig, type DashboardConfig } from '../../src/dashboard/dashboard-config.js';

const sample: DashboardConfig = {
  schemaVersion: 1,
  tiles: [{ id: 't1', kind: 'table', layout: { w: 1, h: 1 }, selection: { table: 'SC.Data.Product' } }],
};

describe('DashboardRepository', () => {
  let db: Database.Database;
  let repo: DashboardRepository;
  beforeEach(() => { db = openDatabase(':memory:'); repo = new DashboardRepository(db); });
  afterEach(() => db.close());

  it('upserts and reads back a full config round-trip', () => {
    repo.upsert('default', 'Dashboard', sample);
    const got = repo.get('default');
    expect(got?.name).toBe('Dashboard');
    expect(got?.config).toEqual(sample);
  });
  it('upsert overwrites config + name + updatedAt for the same id', () => {
    repo.upsert('default', 'Dashboard', emptyDashboardConfig());
    repo.upsert('default', 'Renamed', sample);
    const got = repo.get('default');
    expect(got?.name).toBe('Renamed');
    expect(got?.config.tiles).toHaveLength(1);
    expect(repo.list()).toHaveLength(1);
  });
  it('returns null for an absent id (never seeds on read)', () => {
    expect(repo.get('default')).toBeNull();
    expect(repo.list()).toHaveLength(0);
  });
  it('get() on a corrupted row returns an empty config, leaving the row unchanged', () => {
    db.prepare(`INSERT INTO dashboards (id, name, config_json, updated_at) VALUES ('default','D','{not json', '2020')`).run();
    const got = repo.get('default');
    expect(got?.config).toEqual(emptyDashboardConfig());
    const raw = db.prepare(`SELECT config_json FROM dashboards WHERE id='default'`).get() as { config_json: string };
    expect(raw.config_json).toBe('{not json'); // read did NOT rewrite the row
  });
  it('deletes by id', () => {
    repo.upsert('default', 'Dashboard', sample);
    repo.delete('default');
    expect(repo.get('default')).toBeNull();
  });
});
