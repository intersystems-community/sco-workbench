import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDataBrowserRouter } from '../../src/server/data-browser-routes.js';
import { errorEnvelope } from '../../src/server/error-middleware.js';
import type { IrisServices } from '../../src/iris/index.js';

/** Only `atelier.query` is reached, so only it is faked. */
function fakeIris(handler: (sql: string) => unknown[]): IrisServices {
  return {
    atelier: {
      async query(sql: string) {
        return handler(sql);
      },
    },
  } as unknown as IrisServices;
}

function resolvingIris(total: number): IrisServices {
  return fakeIris((sql) => {
    if (sql.includes('WHERE Name = ?')) {
      return [{ Name: 'SC.Data.BOM', SqlSchemaName: 'SC_Data', SqlTableName: 'BOM' }];
    }
    if (sql.startsWith('SELECT COUNT(*)')) return [{ total }];
    return [];
  });
}

function startApp(iris: IrisServices): Promise<{ app: Express; server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/data-browser', createDataBrowserRouter(iris));
  app.use(errorEnvelope(false));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ app, server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('data-browser routes', () => {
  let server: Server;
  let baseUrl: string;

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('GET /:className/count — resolved', () => {
    beforeAll(async () => {
      ({ server, baseUrl } = await startApp(resolvingIris(1234)));
    });

    it('returns 200 with the class, the SQL table and the total', async () => {
      const res = await fetch(`${baseUrl}/api/data-browser/SC.Data.BOM/count`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        className: 'SC.Data.BOM',
        sqlTableName: 'SC_Data.BOM',
        total: 1234,
      });
    });

    it('matches a path param containing dots without needing encoding', async () => {
      const res = await fetch(`${baseUrl}/api/data-browser/SC.Data.BOM/count`);
      expect(res.status).toBe(200);
    });
  });
});

describe('data-browser routes — unresolvable class', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const iris = fakeIris((sql) => {
      if (sql.includes('%STARTSWITH')) return [{ Name: 'SC.Data.BOM' }, { Name: 'SC.Data.Carrier' }];
      return [];
    });
    ({ server, baseUrl } = await startApp(iris));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 404 with nearest candidates', async () => {
    const res = await fetch(`${baseUrl}/api/data-browser/SC.Data.BOMM/count`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; candidates: string[] };
    expect(body.error).toBe('Class "SC.Data.BOMM" not found.');
    expect(body.candidates).toEqual(['SC.Data.BOM', 'SC.Data.Carrier']);
  });
});

describe('data-browser routes — upstream failure', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const iris = fakeIris(() => {
      throw new Error('ECONNREFUSED 127.0.0.1:52773');
    });
    ({ server, baseUrl } = await startApp(iris));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 502 carrying the upstream message', async () => {
    const res = await fetch(`${baseUrl}/api/data-browser/SC.Data.BOM/count`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toMatch(/ECONNREFUSED 127\.0\.0\.1:52773/);
    expect(body.code).toBe('SCO_PROTOCOL');
  });
});

// A fake that resolves two classes and counts each from a fixed table→total map.
function multiResolvingIris(totals: Record<string, number>): IrisServices {
  return fakeIris((sql) => {
    if (sql.includes('WHERE Name = ?')) {
      // The route resolves each name; answer for the two the test posts. The
      // param isn't visible through this handler shape, so key off the count SQL
      // instead and resolve both known names here.
      return [{ Name: 'SC.Data.BOM', SqlSchemaName: 'SC_Data', SqlTableName: 'BOM' }];
    }
    if (sql.startsWith('SELECT COUNT(*)')) {
      const table = sql.replace('SELECT COUNT(*) AS total FROM ', '').trim();
      return [{ total: totals[table] ?? 0 }];
    }
    return [];
  });
}

describe('POST /counts — bulk row counts', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startApp(multiResolvingIris({ 'SC_Data.BOM': 42 })));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 200 with a counts map keyed by className', async () => {
    const res = await fetch(`${baseUrl}/api/data-browser/counts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classNames: ['SC.Data.BOM'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, { ok: boolean; total?: number }> };
    expect(body.counts['SC.Data.BOM']).toEqual({ ok: true, total: 42, sqlTableName: 'SC_Data.BOM' });
  });

  it('returns 400 when classNames is missing or not an array', async () => {
    const res = await fetch(`${baseUrl}/api/data-browser/counts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classNames: 'SC.Data.BOM' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /counts — per-item failure isolation', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Resolves nothing → every name fails to resolve, but the request still 200s
    // with each entry marked { ok: false }, not a 502 for the whole batch.
    const iris = fakeIris((sql) => {
      if (sql.includes('%STARTSWITH')) return [{ Name: 'SC.Data.BOM' }];
      return [];
    });
    ({ server, baseUrl } = await startApp(iris));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reflects an unresolved name as that entry ok:false, not a whole-batch error', async () => {
    const res = await fetch(`${baseUrl}/api/data-browser/counts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classNames: ['SC.Data.Nope'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, { ok: boolean }> };
    expect(body.counts['SC.Data.Nope']?.ok).toBe(false);
  });
});
