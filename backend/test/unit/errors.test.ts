import { describe, it, expect } from 'vitest';
import {
  parseCompileResult,
  parseImportResult,
  summarizeStatus,
  toMessage,
  normalizeScoBody,
  type AtelierResponse,
} from '../../src/iris/errors.js';

describe('parseCompileResult', () => {
  it('reports success when there are no status errors and no error console lines', () => {
    const res: AtelierResponse<unknown> = {
      status: { errors: [], summary: '' },
      console: [
        'Compilation started on 07/27/2026 at 14:00:00',
        'Compiling class Workbench.Test.Source',
        'Compilation finished successfully in 0.123s.',
      ],
      result: {},
    };
    const parsed = parseCompileResult(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.console).toContain('Compiling class Workbench.Test.Source');
  });

  it('detects errors surfaced only in the console output', () => {
    const res: AtelierResponse<unknown> = {
      status: { errors: [], summary: '' },
      console: [
        'Compiling class Workbench.Test.Bad',
        'ERROR: Workbench.Test.Bad.cls(3) : SyntaxError: expected identifier',
        'Detected 1 errors during compilation.',
        'Compilation finished with errors.',
      ],
      result: {},
    };
    const parsed = parseCompileResult(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join('\n')).toMatch(/SyntaxError/);
  });

  it('coerces object-shaped errors to readable text (no "[object Object]")', () => {
    const res: AtelierResponse<unknown> = {
      status: {
        errors: [{ error: 'ERROR #5373: Class not found', code: 5373, line: 3 }] as unknown[],
      },
      console: [],
      result: {},
    };
    const parsed = parseCompileResult(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toBe('ERROR #5373: Class not found');
    expect(parsed.errors.join('')).not.toMatch(/\[object Object\]/);
  });

  it('detects errors surfaced in status.errors', () => {
    const res: AtelierResponse<unknown> = {
      status: {
        errors: ['ERROR #5373: Class Workbench.Test.Missing referenced but not found'],
        summary: 'ERROR #5373',
      },
      console: [],
      result: {},
    };
    const parsed = parseCompileResult(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toMatch(/#5373/);
  });

  it('treats warnings and informational lines as non-fatal', () => {
    const res: AtelierResponse<unknown> = {
      status: { errors: [], summary: '' },
      console: [
        'Compiling class Workbench.Test.Source',
        'WARNING: deprecated keyword used',
        'Compilation finished successfully in 0.05s.',
      ],
      result: {},
    };
    const parsed = parseCompileResult(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.join('\n')).toMatch(/deprecated/);
  });
});

describe('parseImportResult', () => {
  it('is ok when status has no errors', () => {
    const res: AtelierResponse<{ name: string }> = {
      status: { errors: [], summary: '' },
      console: [],
      result: { name: 'Workbench.Test.Source.cls' },
    };
    expect(parseImportResult(res).ok).toBe(true);
  });

  it('fails when status carries errors', () => {
    const res: AtelierResponse<unknown> = {
      status: { errors: ['ERROR #16004: Datatype value invalid'], summary: '' },
      console: [],
      result: {},
    };
    const parsed = parseImportResult(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toMatch(/#16004/);
  });
});

describe('summarizeStatus', () => {
  it('returns a friendly single-line summary for success', () => {
    expect(summarizeStatus({ ok: true, errors: [], warnings: [], console: [] })).toMatch(/success/i);
  });

  it('joins error messages for failure', () => {
    const msg = summarizeStatus({
      ok: false,
      errors: ['ERROR #5373: not found', 'ERROR: syntax'],
      warnings: [],
      console: [],
    });
    expect(msg).toMatch(/#5373/);
    expect(msg).toMatch(/syntax/);
  });
});

describe('toMessage (case-insensitive keys)', () => {
  it('reads lowercase message/error keys', () => {
    expect(toMessage({ message: 'lower msg' })).toBe('lower msg');
    expect(toMessage({ error: 'lower err' })).toBe('lower err');
  });

  it('reads SCO capital-M Message (the casing bug that rendered blank)', () => {
    expect(toMessage({ Status: 'Error', Message: 'KPI already exists' })).toBe(
      'KPI already exists',
    );
  });

  it('reads capital Error / Text', () => {
    expect(toMessage({ Error: 'ERR #5373' })).toBe('ERR #5373');
    expect(toMessage({ Text: 'some text' })).toBe('some text');
  });

  it('ignores blank strings and falls through to JSON', () => {
    expect(toMessage({ message: '   ' })).toMatch(/\{/);
  });

  it('returns plain strings unchanged', () => {
    expect(toMessage('just text')).toBe('just text');
  });
});

describe('normalizeScoBody', () => {
  it('canonicalizes { Status, Message } regardless of casing', () => {
    const n = normalizeScoBody({ Status: 'Error', Message: 'KPI already exists' });
    expect(n.message).toBe('KPI already exists');
    expect(n.details).toEqual({ Status: 'Error', Message: 'KPI already exists' });
  });

  it('canonicalizes { error, message }', () => {
    const n = normalizeScoBody({ error: 'BadRequest', message: 'missing field' });
    expect(n.message).toBe('missing field');
  });

  it('treats a bare string as the message', () => {
    expect(normalizeScoBody('boom').message).toBe('boom');
  });

  it('returns empty object for non-object input', () => {
    expect(normalizeScoBody(null)).toEqual({});
    expect(normalizeScoBody(42)).toEqual({});
  });
});
