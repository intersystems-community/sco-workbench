/**
 * Parsing + friendly summarization of InterSystems IRIS Atelier REST responses
 * and %Status values.
 *
 * The Atelier API wraps every response in an envelope:
 *   { status: { errors: [...], summary }, console: [...], result: {...} }
 * For `action/compile`, per-line compiler messages appear in `console[]` while
 * top-level failures (parse errors, class-not-found) appear in `status.errors[]`.
 * `result.content` is documented as always empty for compile, so we ignore it.
 */

export interface AtelierStatus {
  // IRIS may return errors as strings or richer objects; we normalize them.
  errors: unknown[];
  summary?: string;
}

export interface AtelierResponse<T> {
  status: AtelierStatus;
  console: unknown[];
  result: T;
}

export interface ParsedResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  console: string[];
}

// Console lines that indicate a hard compilation error.
const ERROR_LINE = /\b(ERROR|SyntaxError|<[A-Z]+>|Detected \d+ error|finished with errors|compilation failed)\b/i;
// Console lines that are warnings (non-fatal).
const WARNING_LINE = /\bWARNING\b/i;

/**
 * Normalize an Atelier envelope into a ParsedResult. `treatConsoleErrorsAsFatal`
 * controls whether error-looking console lines flip `ok` to false (true for
 * compile, where the real diagnostics live in the console).
 */
function parse<T>(
  res: AtelierResponse<T>,
  treatConsoleErrorsAsFatal: boolean,
): ParsedResult {
  const statusErrors = (Array.isArray(res.status?.errors) ? res.status.errors : []).map(toMessage);
  const console = (Array.isArray(res.console) ? res.console : []).map(toMessage);

  const consoleErrors = treatConsoleErrorsAsFatal ? console.filter((l) => ERROR_LINE.test(l)) : [];
  const warnings = console.filter((l) => WARNING_LINE.test(l) && !ERROR_LINE.test(l));

  const errors = [...statusErrors, ...consoleErrors];
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    console,
  };
}

/**
 * Coerce an Atelier error/console entry to a readable string. IRIS may return
 * these as objects (e.g. { error, code, line }) rather than plain strings, so
 * naive stringification yields "[object Object]".
 *
 * The key lookup is CASE-INSENSITIVE and includes IRIS/SCO's capital-cased
 * fields (`Message`, `Error`, `Text`, `Status`). SCO's `{ Status, Message }`
 * bodies previously slipped through because only lowercase `message` was
 * probed, so the UI rendered a bare "400 Bad Request".
 */
export function toMessage(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const lower = lowerKeyView(entry as Record<string, unknown>);
    for (const key of ['error', 'message', 'text', 'msg', 'description', 'status']) {
      const v = lower[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    try {
      return JSON.stringify(entry);
    } catch {
      return String(entry);
    }
  }
  return String(entry);
}

/** Build a lowercased-key view of an object so lookups ignore casing. */
function lowerKeyView(o: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const lk = k.toLowerCase();
    // First occurrence wins (a real `message` beats a later stray key).
    if (!(lk in view)) view[lk] = v;
  }
  return view;
}

/** A canonical view of an SCO/IRIS error body, regardless of field casing. */
export interface NormalizedScoBody {
  code?: string;
  message?: string;
  details?: unknown;
}

/**
 * Normalize an SCO/IRIS error body into a canonical shape. Accepts both
 * `{ Status, Message }` (SCO REST) and `{ error, message }` (Atelier / other)
 * in any casing. Returns the original object as `details` for callers that want
 * the raw payload.
 */
export function normalizeScoBody(raw: unknown): NormalizedScoBody {
  if (typeof raw === 'string') return { message: raw };
  if (!raw || typeof raw !== 'object') return {};
  const lower = lowerKeyView(raw as Record<string, unknown>);
  const message = firstString(lower, ['message', 'error', 'text', 'msg', 'description']);
  const code = firstString(lower, ['code', 'errorcode', 'status']);
  return { code, message, details: raw };
}

function firstString(lower: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = lower[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Parse a compile (`action/compile`) response — console lines are authoritative. */
export function parseCompileResult<T>(res: AtelierResponse<T>): ParsedResult {
  return parse(res, true);
}

/** Parse an import (`PUT doc`) response — only status errors are fatal. */
export function parseImportResult<T>(res: AtelierResponse<T>): ParsedResult {
  return parse(res, false);
}

/** Build a concise, user-facing one/few-line summary of a ParsedResult. */
export function summarizeStatus(parsed: ParsedResult): string {
  if (parsed.ok) {
    const warn = parsed.warnings.length
      ? ` (${parsed.warnings.length} warning${parsed.warnings.length === 1 ? '' : 's'})`
      : '';
    return `Success${warn}.`;
  }
  return `Failed:\n${parsed.errors.map((e) => `  • ${e}`).join('\n')}`;
}
