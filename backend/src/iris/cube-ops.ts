import type { NativeClient } from './native-client.js';
import { stripPrintBuildErrorsHint } from './cube-build-errors.js';

/**
 * DeepSee / IRIS BI cube operations via the Native SDK (`%DeepSee.Utils`).
 * These are the state-changing / inspection calls that have no clean Atelier
 * REST equivalent. Compilation of the cube class is handled separately by the
 * Atelier client; these run *after* the cube class is compiled.
 */

export interface BuildCubeResult {
  ok: boolean;
  cubeName: string;
  factCount?: number;
  message: string;
  /**
   * On failure, the raw decoded `%Status` text from `%BuildCube` with the
   * "run %PrintBuildErrors yourself" pointer stripped. The actionable per-row
   * detail is collected separately from `^DeepSee.BuildErrors` (see
   * [cube-build-errors.ts]); this is the summary fallback.
   */
  rawStatusText?: string;
}

export interface CubeInfoResult {
  cubeName: string;
  exists: boolean;
  factCount?: number;
}

/**
 * Build (populate) a cube from its source table.
 * `##class(%DeepSee.Utils).%BuildCube(cubeName, async=0, verbose=1)` → %Status.
 * We run synchronously (async=0) so the result reflects a completed build.
 *
 * `%BuildCube` takes the DeepSee cube lock for the duration of the build. Because
 * this runs on our long-lived, reused Native connection, that lock is owned by the
 * connection's IRIS process and, unless released, lingers for the life of the
 * connection — so the very next MDX read of the cube (which arrives over HTTP, a
 * SEPARATE IRIS process, via the DeepSee REST client) is refused with
 * `#5001: Cube is locked for rebuilding`. Draining the connection after a
 * completed build (commit any dangling tx + releaseAllLocks) returns it to a
 * clean state and makes the freshly-built cube immediately queryable. This is the
 * same lingering-lock hazard the Ens production path already guards with
 * `drainConnectionState()`.
 */
export function buildCube(native: NativeClient, cubeName: string): BuildCubeResult {
  const status = native.callValue('%DeepSee.Utils', '%BuildCube', cubeName, 0, 1);
  const decoded = native.decodeStatus(status);
  // Release the build lock regardless of outcome: a failed build can still have
  // taken (and left) the lock, and nothing after this point needs it held.
  native.drainConnectionState();
  if (!decoded.ok) {
    // Never surface IRIS's "Do ##class(...).%PrintBuildErrors(...)" pointer to
    // the user; strip it and keep the summary. The per-row detail is collected
    // by the caller from ^DeepSee.BuildErrors (collectBuildErrors).
    const cleaned = stripPrintBuildErrorsHint(decoded.text) || decoded.text;
    return {
      ok: false,
      cubeName,
      message: `Cube build failed: ${cleaned}`,
      rawStatusText: cleaned,
    };
  }
  const factCount = safeFactCount(native, cubeName);
  return {
    ok: true,
    cubeName,
    factCount,
    message:
      factCount === undefined
        ? `Cube "${cubeName}" built successfully.`
        : `Cube "${cubeName}" built successfully with ${factCount} facts.`,
  };
}

/** Inspect a cube: whether it exists and its current fact count. */
export function cubeInfo(native: NativeClient, cubeName: string): CubeInfoResult {
  const exists = toBool(native.callValue('%DeepSee.Utils', '%CubeExists', cubeName));
  if (!exists) return { cubeName, exists: false };
  return { cubeName, exists: true, factCount: safeFactCount(native, cubeName) };
}

/**
 * Drop a cube's fact/index data (used by test cleanup).
 * `##class(%DeepSee.Utils).%KillCube(cubeName)` → %Status.
 */
export function killCube(native: NativeClient, cubeName: string): { ok: boolean; message: string } {
  const status = native.callValue('%DeepSee.Utils', '%KillCube', cubeName);
  const decoded = native.decodeStatus(status);
  return {
    ok: decoded.ok,
    message: decoded.ok ? `Cube "${cubeName}" data removed.` : `Failed to kill cube: ${decoded.text}`,
  };
}

function safeFactCount(native: NativeClient, cubeName: string): number | undefined {
  try {
    const n = native.callValue('%DeepSee.Utils', '%GetCubeFactCount', cubeName);
    // The Native SDK may return integers as BigInt.
    const num = typeof n === 'bigint' ? Number(n) : typeof n === 'number' ? n : Number(n);
    return Number.isFinite(num) ? num : undefined;
  } catch {
    return undefined;
  }
}

function toBool(v: unknown): boolean {
  return v === 1 || v === 1n || v === '1' || v === true;
}
