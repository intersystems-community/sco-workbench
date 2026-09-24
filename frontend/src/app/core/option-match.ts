/**
 * Resolve a user- or AI-supplied term to one of a form dropdown's real options.
 *
 * Guided mode fills form fields on the user's behalf, and many fields are backed
 * by dropdowns whose values are NOT what the user typed in their question. The
 * classic case is an MDX cube dimension: the user says "country" but the only
 * valid option is the fully-qualified member `[customer].[H1].[country]`. A plain
 * exact-match rejects "country", so the assistant used to either hallucinate a
 * bogus value or give up. This resolver bridges that gap with a small,
 * deterministic named-entity match: it recognizes "country" as the trailing level
 * of `[customer].[H1].[country]` and returns that canonical option — while staying
 * conservative enough to refuse (or ask) when several options are equally close.
 *
 * It is intentionally framework-free (pure functions, no Angular) so it can be
 * shared by the KPI, cube, and data-model guided forms and unit-tested in
 * isolation.
 */

/** An option that carries extra human-readable labels to match against (e.g. an
 *  MDX member value plus its caption). A bare string is treated as its own label. */
export interface LabeledOption {
  /** The canonical value stored on the form when this option is chosen. */
  value: string;
  /** Additional display labels/aliases that should also match (e.g. a caption). */
  labels?: readonly string[];
}

/** The outcome of resolving a term against a set of options. */
export type OptionResolution =
  /** Exactly one confident match — its canonical value is safe to apply. */
  | { status: 'matched'; value: string; exact: boolean }
  /** Several plausible options — the caller should list them / ask the user. */
  | { status: 'ambiguous'; candidates: readonly string[] }
  /** Nothing close enough — the caller should reject and list the real options. */
  | { status: 'none' };

/** Lowercase + trim. */
function norm(s: string): string {
  return s.toLowerCase().trim();
}

/** Lowercase and strip everything but letters and digits, so "Order Value",
 *  "order_value" and "orderValue" all compare equal. */
function normAlnum(s: string): string {
  return norm(s).replace(/[^a-z0-9]/g, '');
}

/** The trailing bracketed segment of an MDX member, e.g. `[customer].[H1].[country]`
 *  → "country". Undefined when the string isn't an MDX member. */
function mdxTail(s: string): string | undefined {
  const m = s.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1] : undefined;
}

/** All the searchable keys for an option: its value, every label, and the MDX
 *  trailing segment of any of those. Deduped, non-empty. */
function searchKeys(opt: LabeledOption): string[] {
  const raw = [opt.value, ...(opt.labels ?? [])].filter((s) => s && s.length > 0);
  const keys = new Set<string>();
  for (const k of raw) {
    keys.add(k);
    const tail = mdxTail(k);
    if (tail) keys.add(tail);
  }
  return [...keys];
}

/** Coerce a string | LabeledOption into a LabeledOption. */
function asOption(o: string | LabeledOption): LabeledOption {
  return typeof o === 'string' ? { value: o } : o;
}

/**
 * Resolve `raw` against `options`, tolerating the common label-vs-canonical
 * mismatch (a plain term like "country" for the MDX member
 * `[customer].[H1].[country]`, or "Order Value" for `orderValue`).
 *
 * Matching runs in confidence tiers and stops at the first tier that hits:
 *   1. STRONG — a key equals `raw` exactly, or equals it after alnum-normalizing
 *      (case/spacing/punctuation-insensitive). Includes MDX trailing segments, so
 *      "country" matches `[customer].[H1].[country]`.
 *   2. WEAK — one alnum-normalized key contains the other (both ≥ 3 chars), for
 *      partial terms like "revenue" → "totalRevenue".
 * Within a tier: one distinct value → matched; several → ambiguous (so the caller
 * asks rather than guessing wrong); none → fall through. No tier hits → none.
 *
 * `matched.exact` is true only for a whole-string case-insensitive hit, so callers
 * can tell an exact selection from a fuzzy one (e.g. to phrase the reply).
 */
export function resolveOption(
  raw: string,
  options: ReadonlyArray<string | LabeledOption>,
): OptionResolution {
  const query = norm(raw);
  const queryAlnum = normAlnum(raw);
  if (!query) return { status: 'none' };

  const opts = options.map(asOption).filter((o) => o.value && o.value.length > 0);

  // Whole-string case-insensitive hit on the canonical value → exact.
  const exact = opts.find((o) => norm(o.value) === query);
  if (exact) return { status: 'matched', value: exact.value, exact: true };

  const distinct = (found: LabeledOption[]): string[] => [...new Set(found.map((o) => o.value))];

  // Tier 1 (STRONG): a key equals the query, exactly or after alnum-normalizing.
  const strong = opts.filter((o) =>
    searchKeys(o).some((k) => norm(k) === query || (queryAlnum.length > 0 && normAlnum(k) === queryAlnum)),
  );
  const strongValues = distinct(strong);
  if (strongValues.length === 1) return { status: 'matched', value: strongValues[0]!, exact: false };
  if (strongValues.length > 1) return { status: 'ambiguous', candidates: strongValues };

  // Tier 2 (WEAK): substring containment either direction, guarded by length so a
  // 1-2 char query can't latch onto everything.
  if (queryAlnum.length >= 3) {
    const weak = opts.filter((o) =>
      searchKeys(o).some((k) => {
        const ka = normAlnum(k);
        return ka.length >= 3 && (ka.includes(queryAlnum) || queryAlnum.includes(ka));
      }),
    );
    const weakValues = distinct(weak);
    if (weakValues.length === 1) return { status: 'matched', value: weakValues[0]!, exact: false };
    if (weakValues.length > 1) return { status: 'ambiguous', candidates: weakValues };
  }

  return { status: 'none' };
}
