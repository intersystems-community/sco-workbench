import { describe, it, expect } from 'vitest';
import { toIrisError, httpStatusToError } from '../../src/iris/normalize-error.js';
import {
  IrisUnreachableError,
  IrisTimeoutError,
  IrisAuthError,
  IrisHttpError,
  IrisProtocolError,
  NotFoundError,
  ConflictError,
  CompileError,
} from '../../src/iris/iris-error.js';

describe('toIrisError', () => {
  it('passes an already-typed IrisError through unchanged', () => {
    const original = new CompileError('nope');
    expect(toIrisError(original)).toBe(original);
  });

  it('maps AbortError to a timeout', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const err = toIrisError(abort);
    expect(err).toBeInstanceOf(IrisTimeoutError);
    expect(err.cause).toBe(abort);
  });

  it('maps transient socket codes on cause to unreachable', () => {
    const wrapped = new TypeError('fetch failed');
    (wrapped as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    const err = toIrisError(wrapped);
    expect(err).toBeInstanceOf(IrisUnreachableError);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it('maps a top-level error code to unreachable', () => {
    const e = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(toIrisError(e)).toBeInstanceOf(IrisUnreachableError);
  });

  it('falls back to a protocol error for unknown throws, preserving the message', () => {
    const err = toIrisError(new Error('weird body'));
    expect(err).toBeInstanceOf(IrisProtocolError);
    expect(err.message).toContain('weird body');
  });

  it('prefixes the op when provided', () => {
    const err = toIrisError(new Error('x'), { op: 'compile cube' });
    expect(err.message).toMatch(/^compile cube: /);
  });
});

describe('httpStatusToError', () => {
  it('maps 401/403 to auth', () => {
    expect(httpStatusToError(401, 'no')).toBeInstanceOf(IrisAuthError);
    expect(httpStatusToError(403, 'no')).toBeInstanceOf(IrisAuthError);
  });

  it('maps 404 to not-found and 409 to conflict', () => {
    expect(httpStatusToError(404, 'gone')).toBeInstanceOf(NotFoundError);
    expect(httpStatusToError(409, 'exists')).toBeInstanceOf(ConflictError);
  });

  it('maps other non-2xx to an http error carrying the upstream status', () => {
    const err = httpStatusToError(500, 'boom');
    expect(err).toBeInstanceOf(IrisHttpError);
    expect((err as IrisHttpError).upstreamStatus).toBe(500);
    expect(err.message).toMatch(/HTTP 500/);
    expect(err.message).toMatch(/boom/);
  });

  it('includes the body and status in details', () => {
    const err = httpStatusToError(500, 'boom', { url: 'http://iris/x' });
    expect(err.details).toEqual({ upstreamStatus: 500, body: 'boom', url: 'http://iris/x' });
  });
});
