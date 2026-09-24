/**
 * Guided-mode assignment of a field whose value is CONSTRAINED by the UI control
 * behind it — a `<select>`, a radio group, or a checkbox.
 *
 * The bug this exists to kill: the assistant fills such a field with a value that
 * reads right to a human but matches no option ("InterSystems IRIS" for a Database
 * Type dropdown that offers `IRIS` / `PostgreSQL`; "SFTP" for a boolean `ftpSftp`).
 * A plain write then either leaves the control blank (a `<select>` cannot render an
 * option that doesn't exist) or silently lands on the WRONG choice (a truthiness
 * coercion turns "SFTP" into false → FTP) — while `ui_set_field` reports success, so
 * the assistant tells the user a field is set that isn't.
 *
 * Every constrained field routes through here instead, which gives three outcomes
 * and never a silent one:
 *   • a confident semantic match → the CANONICAL option value, safe to assign;
 *   • several equally close options → rejected, telling the assistant to ask the
 *     user which one (it must confirm, not guess);
 *   • nothing close → rejected WITH the real option list, so the next attempt is
 *     picked from what the control actually offers.
 *
 * Framework-free (no Angular) so the KPI, cube, data-integration and data-model
 * forms can share it and it can be unit-tested on its own.
 */

import { resolveOption, type LabeledOption } from './option-match';

/** A constrained-choice field and the options its control offers. */
export interface OptionFieldSpec {
  /** Human name of the field, used in the rejection message ("database type"). */
  label: string;
  /** The control's options. A bare string is its own label. */
  options: ReadonlyArray<string | LabeledOption>;
  /** How an option reads in the "choose one of" list. Defaults to its value; used
   *  where the stored value is empty or cryptic (e.g. a "(none)" transform). */
  display?: (value: string) => string;
}

/** Outcome of matching a supplied value against a constrained field's options. */
export type OptionFieldMatch =
  /** One confident match — `value` is the canonical option to store. */
  | { ok: true; value: string }
  /** Ambiguous or unmatched — `detail` explains it to the assistant verbatim. */
  | { ok: false; detail: string };

/** Render an option list for a message, via the spec's `display` when given. */
function optionList(spec: OptionFieldSpec): string {
  const show = spec.display ?? ((v: string) => v);
  const values = spec.options.map((o) => (typeof o === 'string' ? o : o.value));
  return values.map(show).join(', ') || '(none)';
}

/**
 * Resolve a supplied value to one of a dropdown's real options.
 *
 * Matching is `resolveOption`'s — exact, then case/punctuation-insensitive
 * (including an MDX member's trailing level), then substring containment — so a
 * semantically close term lands on the right option ("InterSystems IRIS" → `IRIS`,
 * "int" → `Integer`) without the caller re-implementing it per field.
 *
 * Both rejection messages tell the assistant what to do next, because the failure
 * mode being fixed is it retrying with a second invented value: ambiguity means ASK
 * the user, no match means pick from the listed options (or ask). Neither ever
 * assigns anything.
 */
export function matchOptionField(raw: unknown, spec: OptionFieldSpec): OptionFieldMatch {
  const text = String(raw ?? '').trim();
  if (!text) {
    return {
      ok: false,
      detail:
        `An empty value is not a valid ${spec.label}. The control offers ONLY: ${optionList(spec)}. ` +
        `Ask the user which one they want.`,
    };
  }
  const res = resolveOption(text, spec.options);
  if (res.status === 'matched') return { ok: true, value: res.value };
  if (res.status === 'ambiguous') {
    return {
      ok: false,
      detail:
        `"${text}" is equally close to more than one ${spec.label}: ${res.candidates.join(', ')}. ` +
        `Do NOT guess — ask the user which of those they mean (use ask_user_question), then set that exact value.`,
    };
  }
  return {
    ok: false,
    detail:
      `"${text}" is not a valid ${spec.label} — it matches none of the options, so nothing was set. ` +
      `The control offers ONLY: ${optionList(spec)}. Choose the option that means what the user asked for; ` +
      `if none clearly does, ask the user to pick from that list (use ask_user_question). Never set a value ` +
      `that is not on it.`,
  };
}

/** Outcome of matching a supplied value against a two-state control. */
export type BooleanFieldMatch =
  | { ok: true; value: boolean }
  | { ok: false; detail: string };

/** A checkbox or two-option radio group, named by what each state shows. */
export interface BooleanFieldSpec {
  /** Human name of the field ("protocol", "required"). */
  label: string;
  /** What the UI shows for the true state ("SFTP", "checked"). */
  trueLabel: string;
  /** What the UI shows for the false state ("FTP", "unchecked"). */
  falseLabel: string;
  /** Extra accepted spellings of the true state, beyond `trueLabel`. */
  alsoTrue?: readonly string[];
  /** Extra accepted spellings of the false state, beyond `falseLabel`. */
  alsoFalse?: readonly string[];
}

/** Spellings of "on" accepted for every two-state control. */
const GENERIC_TRUE = ['true', 'yes', 'y', '1', 'on', 'checked', 'enabled', 'enable'] as const;
/** Spellings of "off" accepted for every two-state control. */
const GENERIC_FALSE = ['false', 'no', 'n', '0', 'off', 'unchecked', 'disabled', 'disable'] as const;

/** Lowercase, then strip everything but letters and digits. */
function key(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a supplied value to one side of a two-state control.
 *
 * Deliberately WHOLE-STRING matching, not the fuzzy containment `matchOptionField`
 * uses: the two states are often near-anagrams of each other ("FTP" is a substring
 * of "SFTP"), and a substring rule there would flip the protocol silently — the
 * exact bug class this module exists to remove. An unrecognized value is REJECTED
 * with both labels rather than coerced to false, so "SFTP" can never read as FTP.
 */
export function matchBooleanField(raw: unknown, spec: BooleanFieldSpec): BooleanFieldMatch {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  const k = key(String(raw ?? ''));
  const trues = [spec.trueLabel, ...(spec.alsoTrue ?? []), ...GENERIC_TRUE].map(key);
  const falses = [spec.falseLabel, ...(spec.alsoFalse ?? []), ...GENERIC_FALSE].map(key);
  // The true side is checked first, so a label mistakenly listed on both sides of a
  // field's spec resolves consistently instead of depending on iteration order.
  if (k && trues.includes(k)) return { ok: true, value: true };
  if (k && falses.includes(k)) return { ok: true, value: false };
  return {
    ok: false,
    detail:
      `"${String(raw)}" is not a recognized ${spec.label} — nothing was set. This control has exactly two ` +
      `states: "${spec.trueLabel}" or "${spec.falseLabel}". Pass one of those (or true/false). If you are ` +
      `unsure which the user means, ask them (use ask_user_question).`,
  };
}
