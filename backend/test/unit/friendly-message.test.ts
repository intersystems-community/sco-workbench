import { describe, it, expect } from 'vitest';
import { friendlyMessage } from '../../src/iris/friendly-message.js';
import {
  IrisUnreachableError,
  IrisTimeoutError,
  CompileError,
  ConflictError,
  ReadOnlyError,
} from '../../src/iris/iris-error.js';

describe('friendlyMessage', () => {
  it('returns a user-facing sentence per code', () => {
    expect(friendlyMessage(new IrisUnreachableError('x'))).toMatch(/reach SCO/i);
    expect(friendlyMessage(new IrisTimeoutError('x'))).toMatch(/too long/i);
    expect(friendlyMessage(new CompileError('x'))).toMatch(/compile/i);
    expect(friendlyMessage(new ConflictError('x'))).toMatch(/already in use/i);
    expect(friendlyMessage(new ReadOnlyError('x'))).toMatch(/SCO built-in/i);
  });

  it('never returns an empty string', () => {
    for (const err of [new IrisUnreachableError('x'), new CompileError('y')]) {
      expect(friendlyMessage(err).length).toBeGreaterThan(0);
    }
  });
});
