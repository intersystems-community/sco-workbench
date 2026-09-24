/**
 * Helpers for an IRIS level rangeExpression.
 * Syntax: "test:replace;" pairs; a test is a single value or a range,
 * with () exclusive and [] inclusive bounds; an empty bound is open.
 */

/** One range rule, as edited in the builder. An empty min/max is an open bound. */
export interface RangeRule {
  min: string;
  minInclusive: boolean;
  max: string;
  maxInclusive: boolean;
  label: string;
}

/** Parse a rangeExpression into rules. Returns null if any rule doesn't parse. */
export function parseRangeExpression(expr: string | undefined | null): RangeRule[] | null {
  const parts = (expr ?? '').split(';').map((r) => r.trim()).filter(Boolean);
  if (!parts.length) return null;
  const rules: RangeRule[] = [];
  for (const part of parts) {
    const range = /^([[(])\s*([^,]*?)\s*,\s*([^\])]*?)\s*([\])])\s*:(.*)$/.exec(part);
    if (range) {
      const [, open, min, max, close, label] = range;
      rules.push({ min, minInclusive: open === '[', max, maxInclusive: close === ']', label: label.trim() });
      continue;
    }
    const single = /^([^:[\]()]+):(.*)$/.exec(part);
    if (!single) return null;
    const v = single[1].trim();
    rules.push({ min: v, minInclusive: true, max: v, maxInclusive: true, label: single[2].trim() });
  }
  return rules;
}

/** Serialize builder rules. Rules without a label are skipped. */
export function toRangeExpression(rules: RangeRule[]): string {
  return rules
    .filter((r) => r.label.trim())
    .map((r) => {
      const min = r.min.trim();
      const max = r.max.trim();
      const open = min && r.minInclusive ? '[' : '(';
      const close = max && r.maxInclusive ? ']' : ')';
      return `${open}${min},${max}${close}:${r.label.trim().replace(/;/g, '')};`;
    })
    .join('');
}

/**
 * Readable rules, e.g. "(,0]:Expired;(0,7]:Expiring;" → ["≤ 0 → Expired", "> 0 and ≤ 7 → Expiring"].
 * Returns null if any rule doesn't parse, so the caller can show the raw text.
 */
export function formatRangeExpression(expr: string | undefined | null): string[] | null {
  const rules = parseRangeExpression(expr);
  if (!rules) return null;
  return rules.map(({ min, minInclusive, max, maxInclusive, label }) => {
    const lo = `${minInclusive ? '≥' : '>'} ${min}`;
    const hi = `${maxInclusive ? '≤' : '<'} ${max}`;
    let test: string;
    if (min && max) test = min === max && minInclusive && maxInclusive ? `= ${min}` : `${lo} and ${hi}`;
    else if (max) test = hi;
    else if (min) test = lo;
    else test = 'any value';
    return `${test} → ${label}`;
  });
}
