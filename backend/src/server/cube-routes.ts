import { Router, type Request, type Response, type NextFunction } from 'express';
import type { IrisServices } from '../iris/index.js';
import { generateCubeClass, cubeClassName, isWorkbenchCube, validateCubeDefinition } from '../cube/cube-generator.js';
import type { CubeDefinition } from '../cube/cube-definition.model.js';
import { buildCube } from '../iris/cube-ops.js';
import { collectBuildErrors, formatBuildErrorMessage } from '../iris/cube-build-errors.js';
import { resolveClass, listProperties } from '../iris/schema-ops.js';
import {
  listCubes,
  cubeDetail,
  cubeStructure,
  structureFromDefinition,
  deleteCube,
  readCubeDefinition,
  readCubeDefinitionForDisplay,
  type CubeDetailFull,
} from '../iris/cube-catalog-ops.js';
import type { CubeDraftRepository, CubeState } from '../db/cube-drafts.js';
import { toIrisError } from '../iris/normalize-error.js';
import {
  ValidationError,
  NotFoundError,
  ReadOnlyError,
  CompileError,
  BuildError,
  IrisProtocolError,
} from '../iris/iris-error.js';

/**
 * REST routes for the Analytics Cubes editor, with a save → compile → build
 * lifecycle backed by a DB store (so incomplete edits survive navigation):
 *
 *   GET    /api/cubes             list all cubes (IRIS built cubes + saved drafts),
 *                                 each tagged with a state: draft | compiled | built
 *   GET    /api/cubes/:name       one cube's detail + build structure + state
 *   GET    /api/cubes/:name/definition   editable definition (draft if saved, else parsed class)
 *   POST   /api/cubes/save        persist the (possibly incomplete) definition as a draft
 *   POST   /api/cubes/compile     save + generate .cls + compile into IRIS      → state compiled
 *   POST   /api/cubes/build       save + compile + build (populate) the cube    → state built
 *   DELETE /api/cubes/:name       delete the IRIS class (if any) AND the saved draft
 *
 * Compile covers save; build covers save + compile. SCO built-in cubes
 * (SC.Core.Analytics.Cube.*) are read-only — compile/build/delete/definition
 * reject them. Mounted after express.json(), NOT behind the IRIS proxy.
 */
export function createCubeRouter(iris: IrisServices, drafts: CubeDraftRepository): Router {
  const router = Router();

  // --- List (merge built IRIS cubes with saved drafts) ---
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const irisCubes = await listCubes(iris.atelier);
      const draftRows = drafts.list();
      const draftByName = new Map(draftRows.map((d) => [d.cubeName, d]));

      // Start from the live IRIS cubes. A draft row records the CURRENT working
      // state (draft / compiled / built) and supersedes the live class — so if
      // the user edited a built cube and saved a draft, it reads 'draft' again.
      // A live cube with no draft row is simply 'built'.
      interface ListedCube {
        cubeName: string;
        className: string;
        sourceClass?: string;
        editable: boolean;
        state: CubeState;
      }
      const merged: ListedCube[] = irisCubes.map((c) => {
        const draft = draftByName.get(c.cubeName);
        draftByName.delete(c.cubeName);
        const state: CubeState = draft ? draft.state : 'built';
        return { ...c, state };
      });

      // Remaining drafts have no compiled class in IRIS yet → draft (or compiled
      // if a prior compile left a class we couldn't list, but default to draft).
      for (const d of draftByName.values()) {
        merged.push({
          cubeName: d.cubeName,
          className: cubeClassName(d.cubeName),
          sourceClass: d.definition.sourceClass || undefined,
          editable: true,
          state: d.state === 'built' ? 'built' : d.state, // typically 'draft' | 'compiled'
        });
      }
      res.json({ cubes: merged });
    } catch (err) {
      next(toIrisError(err, { op: 'list cubes' }));
    }
  });

  // --- Source-class properties (for the cube form's property dropdowns) ---
  // The cube source can be ANY compiled persistent class (a custom scmodel
  // object OR an SCO built-in like SC.Data.SalesOrder). The scmodel
  // /objects/{name} API only knows custom objects, so the form used to have no
  // property list for a real SCO class and the assistant had to guess. This
  // resolves the class (short or full name) and lists its real properties, so
  // the UI (and the assistant's UI context) always has the authoritative list.
  router.get('/source-properties', async (req: Request, res: Response, next: NextFunction) => {
    const raw = typeof req.query.class === 'string' ? req.query.class.trim() : '';
    if (!raw) return next(new ValidationError('A `class` query parameter is required.'));
    try {
      const resolved = await resolveClass(iris.atelier, raw);
      if (!resolved.exists || !resolved.className) {
        return next(
          new NotFoundError(`Source class "${raw}" was not found in SCO.`, {
            details: { candidates: resolved.candidates ?? [] },
          }),
        );
      }
      const properties = await listProperties(iris.atelier, resolved.className);
      return res.json({ className: resolved.className, properties });
    } catch (err) {
      return next(toIrisError(err, { op: 'list source properties' }));
    }
  });

  // --- Editable definition (draft first, then parse the compiled class) ---
  router.get('/:name/definition', async (req: Request, res: Response, next: NextFunction) => {
    const name = String(req.params.name);
    try {
      // A saved draft is the most faithful editable source (it round-trips even
      // an incomplete cube that was never compiled).
      const draft = drafts.get(name);
      if (draft) return res.json({ definition: draft.definition, editable: true, state: draft.state });

      const definition = await readCubeDefinition(iris.atelier, name);
      if (!definition) {
        // Not editable in the Workbench. `editable:false` is preserved in details
        // so the frontend's existing read keeps working.
        return next(
          new ReadOnlyError(
            `Cube "${name}" is not editable in the Workbench (only cubes created here, under SC.Workbench.Cube.*, can be edited).`,
            { details: { editable: false } },
          ),
        );
      }
      return res.json({ definition, editable: true, state: 'built' });
    } catch (err) {
      return next(toIrisError(err, { op: 'read cube definition' }));
    }
  });

  // --- Detail (build structure + persisted state) ---
  router.get('/:name', async (req: Request, res: Response, next: NextFunction) => {
    const name = String(req.params.name);
    try {
      const detail = await cubeDetail(iris.native, iris.atelier, name);
      const draft = drafts.get(name);
      if (!detail.exists && !detail.sourceClass && !draft) {
        return next(new NotFoundError(`Cube "${name}" not found.`));
      }
      const full: CubeDetailFull & { state?: CubeState } = { ...detail };
      // A saved draft is always a Workbench-owned, editable cube — even before
      // it has a compiled class in IRIS (so cubeDetail couldn't resolve one and
      // wrongly left editable=false). Reflect that.
      if (draft) {
        full.editable = true;
        if (!full.sourceClass) full.sourceClass = draft.definition.sourceClass || undefined;
        full.className = cubeClassName(name);
      }
      full.state = draft ? draft.state : detail.exists ? 'built' : 'draft';
      if (detail.exists) {
        try {
          // Feed the definition so level source properties/expressions (incl. a
          // time dimension's date field) are shown — the D2CLIENT Info API alone
          // doesn't expose them. Prefer the saved draft; else parse the compiled
          // class for DISPLAY (works for SCO built-ins too, read-only).
          const definition = draft?.definition ?? (await readCubeDefinitionForDisplay(iris.atelier, detail.cubeName).catch(() => null));
          Object.assign(full, await cubeStructure(iris.deepsee, detail.cubeName, definition));
        } catch {
          // structure is best-effort
        }
      } else if (draft) {
        // Not built yet (draft / compiled): the D2CLIENT Info API only knows
        // built cubes, so derive the dimensions/measures straight from the saved
        // draft definition — otherwise the detail view wrongly shows "No
        // dimensions/measures defined" for a cube the user just saved.
        Object.assign(full, structureFromDefinition(draft.definition));
      }
      return res.json({ cube: full });
    } catch (err) {
      return next(toIrisError(err, { op: 'cube detail' }));
    }
  });

  // --- Save (draft only; may be incomplete) ---
  router.post('/save', async (req: Request, res: Response, next: NextFunction) => {
    const def = req.body?.definition as CubeDefinition | undefined;
    if (!def || typeof def !== 'object' || !def.cubeName?.trim()) {
      return next(new ValidationError('A cube `definition` with a cubeName is required.'));
    }
    try {
      const cubeName = def.cubeName.trim();
      await cleanupRename(iris, drafts, req.body?.originalName, cubeName);
      // Preserve an already-compiled/built state when the definition hasn't
      // changed. A bare Save (or a queued auto-save) must NOT silently reset a
      // built cube back to 'draft' while its class + data still exist in IRIS —
      // that made the list badge disagree with reality. A save that actually
      // edits the definition does drop to 'draft' (the built cube is now stale).
      const existing = drafts.get(cubeName);
      const unchanged = existing && sameDefinition(existing.definition, def);
      const state: CubeState = unchanged ? existing.state : 'draft';
      const saved = drafts.upsert(cubeName, def, state);
      return res.json({ ok: true, cubeName: saved.cubeName, state: saved.state });
    } catch (err) {
      return next(new IrisProtocolError(`Failed to save draft: ${message(err)}`, { cause: err }));
    }
  });

  // --- Compile (save + generate + compile into IRIS; no build) ---
  router.post('/compile', async (req: Request, res: Response, next: NextFunction) => {
    const def = req.body?.definition as CubeDefinition | undefined;
    if (!def || typeof def !== 'object' || !def.cubeName?.trim()) {
      return next(new ValidationError('A cube `definition` with a cubeName is required.'));
    }
    await cleanupRename(iris, drafts, req.body?.originalName, def.cubeName.trim());
    return runPipeline(iris, drafts, def, 'compile', res, next);
  });

  // --- Build (save + compile + build) ---
  router.post('/build', async (req: Request, res: Response, next: NextFunction) => {
    const def = req.body?.definition as CubeDefinition | undefined;
    if (!def || typeof def !== 'object' || !def.cubeName?.trim()) {
      return next(new ValidationError('A cube `definition` with a cubeName is required.'));
    }
    await cleanupRename(iris, drafts, req.body?.originalName, def.cubeName.trim());
    return runPipeline(iris, drafts, def, 'build', res, next);
  });

  // --- Delete (Workbench cube class if present, plus the saved draft) ---
  router.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
    const name = String(req.params.name);
    try {
      const detail = await cubeDetail(iris.native, iris.atelier, name);
      // If a compiled class exists in IRIS, it must be a Workbench cube to remove.
      if (detail.exists || detail.sourceClass) {
        if (!isWorkbenchCube(detail.className)) {
          return next(
            new ReadOnlyError(`Cube "${name}" is an SCO built-in and cannot be deleted in the Workbench.`),
          );
        }
        const result = deleteCube(iris.native, detail.className);
        if (!result.ok) return next(new IrisProtocolError(result.message));
      }
      // Always drop the saved draft too (a draft-only cube has no IRIS class).
      drafts.delete(name);
      return res.json({ ok: true, message: `Cube "${name}" deleted.` });
    } catch (err) {
      return next(toIrisError(err, { op: 'delete cube' }));
    }
  });

  return router;
}

/**
 * Save-then-(compile|build) pipeline. `save` always happens first (so the draft
 * is persisted even if compile fails), then the definition is validated,
 * source-class-resolved, generated, compiled, and — for `build` — populated.
 * On success the draft's state advances to 'compiled' or 'built'.
 */
async function runPipeline(
  iris: IrisServices,
  drafts: CubeDraftRepository,
  def: CubeDefinition,
  mode: 'compile' | 'build',
  res: Response,
  next: NextFunction,
): Promise<void> {
  const cubeName = def.cubeName.trim();

  // 1. Validate the definition FIRST. A malformed cubeName (space/dot/dash) must
  //    return a clear 400 VALIDATION — not be mistaken for something else. This
  //    has to run before the SCO-collision check below because a malformed name
  //    like "Cube.SalesOrder" resolves (via cubeDetail) to the SCO SalesOrder
  //    cube, which would otherwise return a misleading 403 READ_ONLY. Validation
  //    touches no IRIS state, so running it up front is safe.
  const problems = validateCubeDefinition(def);
  if (problems.length) {
    return next(new ValidationError('Invalid cube definition.', { details: { problems } }));
  }

  // 2. Refuse to compile/build over a non-Workbench (SCO) cube of the same name
  //    BEFORE persisting a draft, so a refused compile never leaves a phantom
  //    draft row that supersedes the SCO cube's state in the list.
  const existing = await cubeDetail(iris.native, iris.atelier, cubeName);
  if (existing.exists && !existing.editable) {
    return next(new ReadOnlyError(`Cube "${cubeName}" is an SCO built-in and cannot be modified here.`));
  }

  // 3. Persist as a draft up front — a failed compile still keeps the user's work.
  try {
    drafts.upsert(cubeName, def, 'draft');
  } catch {
    // non-fatal; continue to compile
  }

  // 4. Resolve the source class to its fully-qualified ObjectScript name (the
  //    UI sends a short name; DependsOn needs the real class or compile #5373s).
  let resolvedDef = def;
  try {
    const resolved = await resolveClass(iris.atelier, def.sourceClass);
    if (!resolved.exists || !resolved.className) {
      return next(
        new NotFoundError(
          `Source class "${def.sourceClass}" was not found in SCO. Use its full class name.`,
          { details: { candidates: resolved.candidates ?? [] } },
        ),
      );
    }
    if (resolved.className !== def.sourceClass) resolvedDef = { ...def, sourceClass: resolved.className };
  } catch (err) {
    return next(toIrisError(err, { op: 'resolve source class' }));
  }

  // 5. Generate + compile (compilation is the cube's validation step).
  let source: string;
  let className: string;
  try {
    source = generateCubeClass(resolvedDef);
    className = cubeClassName(resolvedDef.cubeName);
  } catch (err) {
    return next(new ValidationError(`Cube generation failed: ${message(err)}`, { cause: err }));
  }
  let compile;
  try {
    compile = await iris.atelier.importAndCompile(className, source);
  } catch (err) {
    return next(toIrisError(err, { op: 'compile cube' }));
  }
  if (!compile.ok) {
    return next(
      new CompileError(`Cube class "${className}" failed to compile.`, {
        details: { className, details: compile.errors, console: compile.console },
      }),
    );
  }

  // Compile succeeded → mark compiled (persist the resolved definition).
  drafts.upsert(cubeName, resolvedDef, 'compiled');

  if (mode === 'compile') {
    res.json({ ok: true, cubeName, className, state: 'compiled', message: `Cube "${cubeName}" compiled.` });
    return;
  }

  // 6. Build (populate) the cube, then mark built.
  const build = buildCube(iris.native, cubeName);
  if (!build.ok) {
    // The user must never see IRIS's "run %PrintBuildErrors yourself" hint —
    // collect the actual per-row errors from ^DeepSee.BuildErrors, dedup them,
    // and surface a readable BUILD_FAILED envelope with structured samples the
    // UI can expand. Fall back to the cleaned summary if collection is empty.
    const summary = await collectBuildErrors(iris, cubeName);
    const messageText =
      summary && summary.samples.length
        ? formatBuildErrorMessage(cubeName, summary)
        : build.message;
    return next(
      new BuildError(messageText, {
        details: {
          className,
          cubeName,
          state: 'compiled',
          total: summary?.total,
          distinct: summary?.distinct,
          samples: summary?.samples,
        },
      }),
    );
  }
  drafts.setState(cubeName, 'built');
  res.json({
    ok: true,
    cubeName,
    className,
    state: 'built',
    factCount: build.factCount,
    message: build.message,
  });
}

/**
 * When an edit renames a cube, the new name creates a fresh draft — leaving the
 * old one (and any compiled/built IRIS class under the old name) orphaned and
 * duplicated in the list. Clean up the old identity: drop its draft, and if a
 * Workbench cube class exists under the old name, delete it (data + class).
 * No-op when the name is unchanged or no originalName was provided.
 */
async function cleanupRename(
  iris: IrisServices,
  drafts: CubeDraftRepository,
  originalName: unknown,
  newName: string,
): Promise<void> {
  const oldName = typeof originalName === 'string' ? originalName.trim() : '';
  if (!oldName || oldName === newName) return;
  try {
    drafts.delete(oldName);
    const oldClass = cubeClassName(oldName);
    // Only remove a class we own (SC.Workbench.Cube.*); never an SCO built-in.
    const detail = await cubeDetail(iris.native, iris.atelier, oldName);
    if (detail.exists && isWorkbenchCube(detail.className) && detail.className === oldClass) {
      deleteCube(iris.native, oldClass);
    }
  } catch {
    // best-effort; a failed cleanup shouldn't block saving the renamed cube
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Structural equality of two cube definitions, order-insensitive to JSON key
 * order. Used to decide whether a Save is a no-op (keep the compiled/built
 * state) or a real edit (drop to draft).
 */
function sameDefinition(a: CubeDefinition, b: CubeDefinition): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
