import { describe, it, expect } from 'vitest';
import {
  IrisError,
  IrisUnreachableError,
  IrisTimeoutError,
  IrisAuthError,
  IrisHttpError,
  IrisProtocolError,
  CompileError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ReadOnlyError,
  isIrisError,
} from '../../src/iris/iris-error.js';
import { ClassNotFoundError } from '../../src/iris/row-count-ops.js';

describe('IrisError taxonomy', () => {
  it('each subclass fixes a code and default httpStatus', () => {
    const cases: Array<[IrisError, string, number]> = [
      [new IrisUnreachableError('x'), 'SCO_UNREACHABLE', 502],
      [new IrisTimeoutError('x'), 'SCO_TIMEOUT', 504],
      [new IrisAuthError('x'), 'SCO_AUTH', 502],
      [new IrisHttpError(500, 'x'), 'SCO_HTTP', 502],
      [new IrisProtocolError('x'), 'SCO_PROTOCOL', 502],
      [new CompileError('x'), 'COMPILE_FAILED', 422],
      [new ValidationError('x'), 'VALIDATION', 400],
      [new NotFoundError('x'), 'NOT_FOUND', 404],
      [new ConflictError('x'), 'CONFLICT', 409],
      [new ReadOnlyError('x'), 'READ_ONLY', 403],
    ];
    for (const [err, code, status] of cases) {
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(status);
      expect(err).toBeInstanceOf(IrisError);
      expect(err).toBeInstanceOf(Error);
      expect(isIrisError(err)).toBe(true);
    }
  });

  it('carries details and cause', () => {
    const cause = new Error('root');
    const err = new CompileError('failed', { details: { console: ['ERROR x'] }, cause });
    expect(err.details).toEqual({ console: ['ERROR x'] });
    expect(err.cause).toBe(cause);
  });

  it('IrisHttpError records the upstream status', () => {
    const err = new IrisHttpError(503, 'boom');
    expect(err.upstreamStatus).toBe(503);
  });

  it('names each error after its class for readable stack traces', () => {
    expect(new NotFoundError('x').name).toBe('NotFoundError');
    expect(new ConflictError('x').name).toBe('ConflictError');
  });

  it('ClassNotFoundError is a NotFoundError carrying candidates', () => {
    const err = new ClassNotFoundError('SC.Data.Nope', ['SC.Data.Nope1', 'SC.Data.Nope2']);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(IrisError);
    expect(err.httpStatus).toBe(404);
    expect(err.candidates).toEqual(['SC.Data.Nope1', 'SC.Data.Nope2']);
    expect(err.details).toEqual({ candidates: ['SC.Data.Nope1', 'SC.Data.Nope2'] });
  });

  it('isIrisError is false for plain errors', () => {
    expect(isIrisError(new Error('x'))).toBe(false);
    expect(isIrisError('x')).toBe(false);
  });
});
