import { describe, it, expect, afterAll } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { errorEnvelope, apiNotFound } from '../../src/server/error-middleware.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ReadOnlyError,
  CompileError,
  IrisUnreachableError,
  IrisTimeoutError,
} from '../../src/iris/iris-error.js';

/** Mount a route that throws `err`, plus the envelope, and return the base URL. */
function appThatThrows(err: unknown, production = false): { server: Server; base: string } {
  const app: Express = express();
  app.get('/boom', (_req, _res, next) => next(err));
  app.use(apiNotFound());
  app.use(errorEnvelope(production));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('errorEnvelope', () => {
  const servers: Server[] = [];
  const start = (err: unknown, production = false) => {
    const { server, base } = appThatThrows(err, production);
    servers.push(server);
    return base;
  };

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it('maps each IrisError to its status and code', async () => {
    const cases: Array<[unknown, number, string]> = [
      [new ValidationError('bad'), 400, 'VALIDATION'],
      [new ReadOnlyError('ro'), 403, 'READ_ONLY'],
      [new NotFoundError('nf'), 404, 'NOT_FOUND'],
      [new ConflictError('dup'), 409, 'CONFLICT'],
      [new CompileError('cf'), 422, 'COMPILE_FAILED'],
      [new IrisUnreachableError('down'), 502, 'SCO_UNREACHABLE'],
      [new IrisTimeoutError('slow'), 504, 'SCO_TIMEOUT'],
    ];
    for (const [err, status, code] of cases) {
      const base = start(err);
      const res = await fetch(`${base}/boom`);
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe('string');
    }
  });

  it('merges plain-object details to the top level (candidates/problems/console)', async () => {
    const base = start(
      new NotFoundError('Source class not found', { details: { candidates: ['A', 'B'] } }),
    );
    const res = await fetch(`${base}/boom`);
    const body = (await res.json()) as { candidates: string[]; code: string };
    expect(body.candidates).toEqual(['A', 'B']);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('surfaces a compile error with className/console/details preserved', async () => {
    const base = start(
      new CompileError('Cube failed to compile.', {
        details: { className: 'SC.Workbench.Cube.X', details: ['ERROR: parse'], console: ['line 1'] },
      }),
    );
    const res = await fetch(`${base}/boom`);
    const body = (await res.json()) as { className: string; details: string[]; console: string[] };
    expect(body.className).toBe('SC.Workbench.Cube.X');
    expect(body.details).toContain('ERROR: parse');
    expect(body.console).toContain('line 1');
  });

  it('normalizes a raw (non-Iris) error to a generic 500, hiding the message in production', async () => {
    const dev = start(new Error('secret detail'), false);
    const devBody = (await (await fetch(`${dev}/boom`)).json()) as { error: string; code: string };
    expect(devBody.code).toBe('INTERNAL');
    expect(devBody.error).toBe('secret detail');

    const prod = start(new Error('secret detail'), true);
    const prodRes = await fetch(`${prod}/boom`);
    expect(prodRes.status).toBe(500);
    const prodBody = (await prodRes.json()) as { error: string };
    expect(prodBody.error).not.toContain('secret detail');
  });

  it('apiNotFound returns the envelope for an unknown /api path', async () => {
    const base = start(new Error('unused'));
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });
});
