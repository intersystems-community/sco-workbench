---
name: compile-class
description: Import and compile an ObjectScript .cls class into the running SCO container via the Atelier REST API. Use whenever the user provides or asks to deploy, import, or compile an SCO/ObjectScript class (any .cls source) — including business services, business processes, data models, or cube classes — and wants it compiled in SCO with success/error feedback.
---

# Compile an ObjectScript Class into SCO

You deploy an ObjectScript `.cls` into the running SCO container using the `sco_compile_class` tool, which uploads the source and compiles it through the Atelier Source Code REST API. Compiling changes the SCO instance, so the user will be asked to approve it.

## Workflow
1. Obtain the full class source and its fully-qualified class name (e.g. `Workbench.Test.BP`). If the user pasted source without a name, read the `Class X.Y.Z ...` line to get the name; if it's ambiguous, ask.
2. Call **`sco_compile_class`** with `{ className, source }`. This imports (PUT) the source, re-reads it to confirm it landed, then compiles (POST). It returns:
   - on success: a confirmation plus any non-fatal `warnings` and the compiler `console` output;
   - on failure: `errors` and the raw `console` lines.
3. **Interpret results honestly.** Compiler severity: informational and warnings are non-fatal; errors block compilation. If it failed, quote the specific error/console line to the user (e.g. a `SyntaxError` with its line number, or an `ERROR #nnnn`), and suggest the fix. Do not claim success unless the tool reports `ok`.

## Notes
- Use `sco_import_class` (import only, no compile) only when the user explicitly wants to stage source without compiling; the normal path is `sco_compile_class`.
- To compile several dependent classes, compile them and address errors in dependency order (a class referencing another that isn't compiled yet yields a "class not found" error — compile the dependency first).
- Never fabricate a compile result. If the tool errors (e.g. SCO unreachable), report that plainly.
