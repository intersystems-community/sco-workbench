// backend/test/unit/csv-inspect.test.ts
import { describe, it, expect } from 'vitest';
import { parseCsv, countLines } from '../../src/util/csv-inspect.js';

describe('countLines', () => {
  it('counts newline characters (both SFTP and FTP use it to bound a preview read)', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a,b')).toBe(0);          // no terminator yet
    expect(countLines('a,b\n1,2\n')).toBe(2);
    expect(countLines('a\r\nb\r\n')).toBe(2);   // \n counted, \r ignored
  });
});

describe('parseCsv', () => {
  it('parses quoted fields with commas and escaped quotes', () => {
    const text = 'a,"b,c","d""e"\n1,2,3\n';
    expect(parseCsv(text, 6)).toEqual([['a', 'b,c', 'd"e'], ['1', '2', '3']]);
  });
  it('stops at maxRows and drops a trailing partial line when capped', () => {
    const text = 'r1\nr2\nr3\nr4-partial';
    expect(parseCsv(text, 3)).toEqual([['r1'], ['r2'], ['r3']]);
  });
  it('keeps a final unterminated row when under the row cap', () => {
    expect(parseCsv('r1\nr2', 6)).toEqual([['r1'], ['r2']]);
  });
  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n', 6)).toEqual([['a', 'b'], ['1', '2']]);
  });
});
