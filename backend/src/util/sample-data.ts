// backend/src/util/sample-data.ts
//
// The example ("sample") data sets shipped beside the repo: one SUBFOLDER per set,
// each holding that set's CSVs plus an optional `intro.txt` describing it. The "Load
// sample data" page shows those folder names in a dropdown (`listSampleDataFolders`),
// shows the set's own description when one is picked (`readSampleDataIntro`), and loads
// one set's CSVs into IRIS (`listSampleDataCsvFiles` + `readSampleDataCsv`). Which
// SC_Data table each CSV goes into is `sc-data-mapping.ts` and the load itself is
// `iris/sc-data-load-ops.ts`; this module only finds and reads files.
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../config/env.js";

/**
 * The repo root — three levels above this module, whether it runs from `src/util`
 * (tsx/vitest) or the compiled `dist/util` (both are two dirs under `backend/`).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Where the sample data sets live when SAMPLE_DATA_DIR is not configured. */
export const DEFAULT_SAMPLE_DATA_DIR = join(REPO_ROOT, "SampleData");

/**
 * The directory to list. An explicit `SAMPLE_DATA_DIR` wins (a container mounts
 * the folder wherever it likes); an empty/unset value falls back to the repo's own
 * `SampleData/`, so a dev checkout needs no configuration at all.
 */
export function resolveSampleDataDir(env: Pick<Env, "SAMPLE_DATA_DIR">): string {
    const configured = env.SAMPLE_DATA_DIR?.trim();
    return configured ? resolve(configured) : DEFAULT_SAMPLE_DATA_DIR;
}

/**
 * The names (not paths) of the sample data sets in `dir`, alphabetically.
 *
 * Only DIRECTORIES count — a stray file next to the sets is not a data set — and
 * dot-entries are skipped, which is what keeps macOS's `.DS_Store` out of the
 * dropdown. A symlinked folder is included (it is a folder to the user); a dangling
 * one is not.
 *
 * A MISSING directory is an empty list, not an error: `SampleData/` is not tracked
 * in git, so a fresh clone legitimately has none, and the page should say "no
 * sample data" rather than show a failure. Anything else (an unreadable dir, a
 * permission error) still throws — that is a real fault worth surfacing.
 */
export async function listSampleDataFolders(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return [];
        throw err;
    }

    const names: string[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
            names.push(entry.name);
        } else if (entry.isSymbolicLink()) {
            // readdir doesn't follow links, so ask what it points at; a broken link
            // throws here and is simply left out.
            try {
                if ((await stat(join(dir, entry.name))).isDirectory()) names.push(entry.name);
            } catch {
                /* dangling symlink — not a usable data set */
            }
        }
    }
    return names.sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Is `name` usable as a data-set folder name — i.e. ONE path segment inside the
 * SampleData directory?
 *
 * The set name arrives from the browser, so this is the traversal guard: `..`,
 * `a/b`, `/etc`, `C:\x` and a NUL-poisoned name are all rejected before any path is
 * built from it. (Callers additionally check the name against
 * `listSampleDataFolders`, which can only ever return real single-segment entries —
 * two independent reasons a crafted name cannot escape the directory.)
 */
export function isSampleDataSetName(name: string): boolean {
    if (!name || name !== name.trim()) return false;
    if (name === "." || name === "..") return false;
    if (name.startsWith(".")) return false; // dot-entries are not listed as sets either
    return !/[/\\\0]/.test(name);
}

/** The directory for one data set, or null when the name isn't a safe segment. */
export function sampleDataSetPath(dir: string, name: string): string | null {
    return isSampleDataSetName(name) ? join(dir, name) : null;
}

/**
 * The CSV file names in one data set's directory, alphabetically. Files only (a
 * symlink to a file counts, a subdirectory does not) and dot-files are skipped, so
 * a `.csv` inside a nested folder is not loaded and macOS metadata never becomes a
 * table.
 *
 * A missing directory answers `[]`, matching `listSampleDataFolders`: the set may
 * have been deleted between listing it and loading it, and "this set has no CSV
 * files" is the honest report either way. A genuinely unreadable directory throws.
 */
export async function listSampleDataCsvFiles(setDir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(setDir, { withFileTypes: true });
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return [];
        throw err;
    }

    const names: string[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (!/\.csv$/i.test(entry.name)) continue;
        if (entry.isFile()) {
            names.push(entry.name);
        } else if (entry.isSymbolicLink()) {
            try {
                if ((await stat(join(setDir, entry.name))).isFile()) names.push(entry.name);
            } catch {
                /* dangling symlink — nothing to read */
            }
        }
    }
    return names.sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Read one CSV's text. `file` must be a name from `listSampleDataCsvFiles` — it is
 * rejected here too if it is not a single segment, so the guard holds even if a
 * future caller passes a name straight through from a request.
 */
export async function readSampleDataCsv(setDir: string, file: string): Promise<string> {
    if (/[/\\\0]/.test(file) || file === "." || file === "..") {
        throw new Error(`"${file}" is not a file name inside the data set.`);
    }
    return readFile(join(setDir, file), "utf8");
}

/** The file a data set uses to say what it contains, shown when the set is picked. */
const INTRO_FILE = "intro.txt";

/**
 * Longest intro served. Whoever writes an `intro.txt` decides what goes in it, and this
 * text lands in a page above the table list — so a file that turns out to be a whole
 * report is cut rather than allowed to bury the list it introduces.
 */
const MAX_INTRO_CHARS = 2_000;

/**
 * What the data set says about itself — its `intro.txt`, or `''` when it has none.
 *
 * A missing intro is the ordinary case (the shipped sets have one; a set someone drops in
 * need not), so it is NOT an error. Neither is an unreadable one: this text only
 * introduces the table list, and losing the description must not cost the user the list
 * or the Load button, so every failure here answers `''`.
 *
 * `intro.txt` is not a CSV, so `listSampleDataCsvFiles` never offers it to the loader —
 * nothing in it is ever loaded into a table.
 */
export async function readSampleDataIntro(setDir: string): Promise<string> {
    try {
        return tidyIntro(await readFile(join(setDir, INTRO_FILE), "utf8"));
    } catch {
        /* Absent, or a directory of that name — try the other spellings before giving up. */
    }
    // Case matters on Linux but not on macOS, so a set authored with `Intro.txt` would
    // work for whoever added it and then show nothing in the container.
    try {
        const entries = await readdir(setDir, { withFileTypes: true });
        const match = entries.find((e) => e.name.toLowerCase() === INTRO_FILE && !e.isDirectory());
        return match ? tidyIntro(await readFile(join(setDir, match.name), "utf8")) : "";
    } catch {
        return "";
    }
}

/**
 * The text as a page can render it: no BOM, newlines the browser's own kind, no run of
 * blank lines longer than one (the paragraph break the page keeps), and capped.
 */
function tidyIntro(text: string): string {
    const clean = text
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return clean.length > MAX_INTRO_CHARS ? `${clean.slice(0, MAX_INTRO_CHARS).trimEnd()}…` : clean;
}
