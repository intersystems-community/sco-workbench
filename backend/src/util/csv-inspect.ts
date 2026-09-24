// backend/src/util/csv-inspect.ts

/**
 * CSV substrate for Data Integration source previews: turn bounded raw bytes into
 * rows, and count lines so every transport bounds its preview read identically.
 *
 * This is deliberately the format-agnostic layer only. Header detection and type
 * inference (inspectCsv / inferCsvType / detectHeader) are the CSV *intelligence*
 * and live in Part 2 — nothing here depends on them, and the routes return these
 * raw rows unchanged until Part 2 wires the inspection in.
 *
 * parseCsv was previously duplicated (backend sftp-browse.ts + the frontend
 * component); this is now its single backend home.
 */

/** Rows to return for a preview: a header row + the first five data rows. */
export const PREVIEW_ROWS = 6;
/** Hard cap on bytes read for a preview, so we never pull a huge file. */
export const MAX_PREVIEW_BYTES = 64 * 1024;

/**
 * Parse up to `maxRows` rows from CSV text. Quote-aware: handles commas and
 * newlines inside double-quoted fields and escaped quotes (`""`). Trailing
 * partial lines (from a bounded read) are dropped. Adequate for a small trusted
 * preview, not a full RFC-4180 library.
 */
export function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; sawAny = true; continue; }
    if (c === ',') { row.push(field); field = ''; sawAny = true; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++; // CRLF
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      sawAny = false;
      continue;
    }
    field += c;
    sawAny = true;
  }
  // A final row WITHOUT a trailing newline is only kept if the buffer ended
  // naturally (we haven't reached maxRows) — otherwise it may be a partial line
  // cut by the byte cap, so we drop it.
  if (rows.length < maxRows && (sawAny || field.length)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Count newline characters in a buffer. Every transport's bounded preview read
 * uses this to stop once it has read enough lines, so SFTP and FTP bound their
 * reads identically (no row-stop asymmetry). Moved here from the former
 * sftp-browse.ts so there is one copy.
 */
export function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}
