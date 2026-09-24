import type { IrisServices } from './index.js';

/**
 * Collect the per-row errors IRIS records when `%BuildCube` fails.
 *
 * When a cube build fails, `%BuildCube`'s own `%Status` is only a summary hint —
 * e.g. "There were 1445 errors while building cube SALESORDER. For more detailed
 * information: Do ##class(%DeepSee.Utils).%PrintBuildErrors("SALESORDER")." We
 * must never surface that "run this classmethod yourself" pointer to the user;
 * the real, actionable messages live in the `^DeepSee.BuildErrors(<CUBE>)` global
 * (the same data `%PrintBuildErrors` prints to the current device). There is no
 * public API to read it as data (`%GetBuildErrors` does not exist), so we walk
 * the global via a tiny helper class and decode each stored `%Status` to text.
 *
 * The messages are DEDUPED by a normalized form (the per-row "(Source ID:'N')"
 * is stripped) so 1445 identical validation failures collapse to one line with a
 * count, keeping the surfaced error readable.
 */

export interface BuildErrorSample {
  /** A representative human-readable message for this group. */
  message: string;
  /** How many row errors collapsed into this group. */
  count: number;
}

export interface BuildErrorSummary {
  /** Total row-level errors IRIS recorded for the build. */
  total: number;
  /** Number of distinct (normalized) messages. */
  distinct: number;
  /** Deduped messages, most-relevant first, capped at `maxSamples`. */
  samples: BuildErrorSample[];
}

const HELPER_CLASS = 'SC.Workbench.Util.CubeBuildErrors';
const RS = String.fromCharCode(30); // record separator between samples
const US = String.fromCharCode(31); // unit separator within a sample

/**
 * ObjectScript helper: walk `^DeepSee.BuildErrors(<CUBE>)`, decode each row's
 * `%Status`, dedup by a normalized message (row-specific "(Source ID:'N')"
 * removed), and return a packed string:
 *   total US distinct  ( RS message US count )*
 */
const HELPER_SOURCE = `Class ${HELPER_CLASS} Extends %RegisteredObject
{

/// Strip the row-specific "(Source ID:'N')" fragment so identical row failures dedup.
ClassMethod Norm(txt As %String) As %String
{
    Set out = txt
    Set p = $Find(out, "(Source ID:")
    If p > 0 {
        Set close = $Find(out, ")", p)
        If close > 0 Set out = $Extract(out, 1, p - 12) _ $Extract(out, close, *)
    }
    Quit $ZStrip(out, "<>W")
}

/// Collect deduped build errors for a cube. RS=$C(30) between groups, US=$C(31) within.
ClassMethod Collect(cube As %String, max As %Integer = 20) As %String
{
    Set cubeU = $ZConvert(cube, "U")
    Set total = +$Get(^DeepSee.BuildErrors(cubeU))
    Set n = 0, k = ""
    For {
        Set k = $Order(^DeepSee.BuildErrors(cubeU, k))
        Quit:k=""
        Set st = $Get(^DeepSee.BuildErrors(cubeU, k))
        Continue:st=""
        Set full = $ZStrip($SYSTEM.Status.GetErrorText(st), "<>W")
        Continue:full=""
        Set key = ..Norm(full)
        If '$Data(count(key)) {
            Set n = n + 1
            Set order(n) = key
            Set sample(key) = full
        }
        Set count(key) = $Get(count(key)) + 1
    }
    Set out = total _ $Char(31) _ $Get(n)
    For i=1:1:$Get(n) {
        Quit:i>max
        Set key = order(i)
        Set out = out _ $Char(30) _ sample(key) _ $Char(31) _ count(key)
    }
    Quit out
}

}`;

/**
 * Compile the helper class once per process. Idempotent: re-importing identical
 * source is cheap, and the cached promise means concurrent builds share one
 * compile. Returns false if the helper could not be compiled (collection is then
 * skipped and the caller falls back to the cleaned summary message).
 */
let ensured: Promise<boolean> | null = null;
function ensureHelper(iris: IrisServices): Promise<boolean> {
  if (!ensured) {
    ensured = iris.atelier
      .importAndCompile(HELPER_CLASS, HELPER_SOURCE)
      .then((r) => r.ok)
      .catch(() => false);
  }
  return ensured;
}

/**
 * Read and dedup the recorded build errors for `cubeName`. Returns null when the
 * helper is unavailable or the global is empty/unreadable — callers should then
 * fall back to the cleaned top-level build message.
 */
export async function collectBuildErrors(
  iris: IrisServices,
  cubeName: string,
  opts: { maxSamples?: number } = {},
): Promise<BuildErrorSummary | null> {
  const maxSamples = opts.maxSamples ?? 20;
  try {
    if (!(await ensureHelper(iris))) return null;
    const packed = String(iris.native.callValue(HELPER_CLASS, 'Collect', cubeName, maxSamples));
    if (!packed) return null;
    const [head, ...groups] = packed.split(RS);
    const [totalStr, distinctStr] = (head ?? '').split(US);
    const total = Number(totalStr) || 0;
    const distinct = Number(distinctStr) || 0;
    if (total === 0 && groups.length === 0) return null;
    const samples: BuildErrorSample[] = groups
      .map((g) => {
        const [message, countStr] = g.split(US);
        return { message: (message ?? '').trim(), count: Number(countStr) || 0 };
      })
      .filter((s) => s.message.length > 0);
    return { total, distinct, samples };
  } catch {
    return null;
  }
}

/**
 * Strip the "For more detailed information: Do ##class(...).%PrintBuildErrors(...)"
 * pointer from a `%BuildCube` summary status, so we never tell the user to run a
 * classmethod themselves. Returns the leading, human-relevant part.
 */
export function stripPrintBuildErrorsHint(message: string): string {
  return message
    .replace(/\s*For more detailed information:.*$/is, '')
    .replace(/\s*Do\s+##class\([^)]*\)\.%PrintBuildErrors\([^)]*\)\.?/gi, '')
    .trim();
}

/**
 * Compose a single, readable message from a build-error summary: the count plus
 * each deduped row error (with its own occurrence count when > 1).
 */
export function formatBuildErrorMessage(cubeName: string, summary: BuildErrorSummary): string {
  const header =
    summary.total === 1
      ? `Cube "${cubeName}" build failed with 1 row error:`
      : `Cube "${cubeName}" build failed with ${summary.total} row errors:`;
  const lines = summary.samples.map((s) => (s.count > 1 ? `• (×${s.count}) ${s.message}` : `• ${s.message}`));
  const omitted = summary.distinct - summary.samples.length;
  if (omitted > 0) lines.push(`• …and ${omitted} more distinct error${omitted === 1 ? '' : 's'}.`);
  return [header, ...lines].join('\n');
}
