import { matchBooleanField, matchOptionField } from './option-field';

/**
 * The constrained-field assignment guard. Every guided-mode write to a `<select>`,
 * radio group or checkbox goes through these two, so what they do IS the contract:
 * a semantically close term resolves to the canonical option, anything unclear is
 * REJECTED with instructions to ask the user, and nothing is ever assigned silently.
 */
describe('matchOptionField — dropdown-backed guided writes', () => {
  const DB_TYPES = [
    { value: 'IRIS', labels: ['InterSystems IRIS', 'Caché'] },
    { value: 'PostgreSQL', labels: ['Postgres', 'PG'] },
  ];

  it('resolves the real-world miss that motivated this: "InterSystems IRIS" → IRIS', () => {
    expect(matchOptionField('InterSystems IRIS', { label: 'database type', options: DB_TYPES }))
      .toEqual({ ok: true, value: 'IRIS' });
  });

  it('resolves an alias and an abbreviation to the canonical option', () => {
    const spec = { label: 'database type', options: DB_TYPES };
    expect(matchOptionField('Postgres', spec)).toEqual({ ok: true, value: 'PostgreSQL' });
    expect(matchOptionField('pg', spec)).toEqual({ ok: true, value: 'PostgreSQL' });
  });

  it('passes an exact option through unchanged', () => {
    expect(matchOptionField('PostgreSQL', { label: 'database type', options: DB_TYPES }))
      .toEqual({ ok: true, value: 'PostgreSQL' });
  });

  it('rejects an off-list value, listing the real options and forbidding invention', () => {
    const r = matchOptionField('MySQL', { label: 'database type', options: DB_TYPES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain('IRIS, PostgreSQL');
      expect(r.detail).toContain('nothing was set');
      expect(r.detail).toContain('ask the user');
    }
  });

  it('rejects an ambiguous term and tells the assistant to confirm with the user', () => {
    const r = matchOptionField('order value', {
      label: 'measure',
      options: ['totalOrderValue', 'averageOrderValue'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain('totalOrderValue, averageOrderValue');
      expect(r.detail).toContain('Do NOT guess');
      expect(r.detail).toContain('ask_user_question');
    }
  });

  it('rejects an empty value rather than blanking the control', () => {
    const r = matchOptionField('   ', { label: 'database type', options: DB_TYPES });
    expect(r.ok).toBe(false);
  });

  it('renders options through `display` so an empty value reads as something', () => {
    const r = matchOptionField('nope', {
      label: 'transform',
      options: ['', 'ToUpper'],
      display: (v) => v || '(none)',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('(none), ToUpper');
  });

  it('keeps Date and DateTime apart (exact wins over containment)', () => {
    const spec = { label: 'column type', options: ['String', 'Integer', 'Date', 'DateTime'] };
    expect(matchOptionField('date', spec)).toEqual({ ok: true, value: 'Date' });
    expect(matchOptionField('datetime', spec)).toEqual({ ok: true, value: 'DateTime' });
    expect(matchOptionField('int', spec)).toEqual({ ok: true, value: 'Integer' });
  });
});

describe('matchBooleanField — checkbox / two-option radio guided writes', () => {
  const PROTOCOL = { label: 'protocol', trueLabel: 'SFTP', falseLabel: 'FTP' };

  it('reads the UI label for each state — "SFTP" is not FTP', () => {
    expect(matchBooleanField('SFTP', PROTOCOL)).toEqual({ ok: true, value: true });
    expect(matchBooleanField('FTP', PROTOCOL)).toEqual({ ok: true, value: false });
  });

  it('accepts the generic on/off spellings', () => {
    for (const on of [true, 'true', 'Yes', 'y', '1', 'on', 'enabled']) {
      expect(matchBooleanField(on, PROTOCOL)).toEqual({ ok: true, value: true });
    }
    for (const off of [false, 'false', 'No', 'n', '0', 'off', 'disabled']) {
      expect(matchBooleanField(off, PROTOCOL)).toEqual({ ok: true, value: false });
    }
  });

  it('REJECTS an unrecognized value instead of coercing it to false', () => {
    const r = matchBooleanField('secure transfer', PROTOCOL);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain('"SFTP" or "FTP"');
      expect(r.detail).toContain('nothing was set');
    }
  });

  it('accepts extra per-field spellings when the field declares them', () => {
    const spec = { ...PROTOCOL, alsoTrue: ['secure ftp'], alsoFalse: ['plain ftp'] };
    expect(matchBooleanField('Secure FTP', spec)).toEqual({ ok: true, value: true });
    expect(matchBooleanField('plain-ftp', spec)).toEqual({ ok: true, value: false });
  });
});
