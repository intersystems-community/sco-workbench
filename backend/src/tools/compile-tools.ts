import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { IrisServices } from '../iris/index.js';
import { summarizeStatus } from '../iris/errors.js';
import { ok, fail, guard } from './result.js';

/**
 * Tools for importing and compiling ObjectScript classes via the Atelier REST
 * API. State-changing — gated by the confirmation callback in the agent layer.
 */
export function compileTools(iris: IrisServices) {
  const importClass = tool(
    'sco_import_class',
    'Import (upload) an ObjectScript class .cls source into SCO via the Atelier REST API, WITHOUT compiling. Use sco_compile_class afterwards, or use this only when you need to stage source. Changes the SCO instance.',
    {
      className: z.string().describe('Fully-qualified class name, e.g. "Workbench.Test.Source" (no .cls suffix).'),
      source: z.string().describe('Full ObjectScript class source text.'),
    },
    async ({ className, source }) =>
      guard(async () => {
        const res = await iris.atelier.importClass(className, source);
        return res.ok
          ? ok({ className, message: `Imported ${className}.` })
          : fail(`Import failed for ${className}: ${summarizeStatus(res)}`, { errors: res.errors });
      }),
    { annotations: { title: 'Import SCO class', readOnlyHint: false } },
  );

  const compileClass = tool(
    'sco_compile_class',
    'Import an ObjectScript class .cls source into SCO and compile it via the Atelier REST API. Returns compiler diagnostics. This is the normal way to deploy a class. Changes the SCO instance.',
    {
      className: z.string().describe('Fully-qualified class name, e.g. "Workbench.Test.BP".'),
      source: z.string().describe('Full ObjectScript class source text to import then compile.'),
    },
    async ({ className, source }) =>
      guard(async () => {
        const res = await iris.atelier.importAndCompile(className, source);
        return res.ok
          ? ok({
              className,
              message: `Compiled ${className} successfully.`,
              warnings: res.warnings,
              console: res.console,
            })
          : fail(`Compilation failed for ${className}: ${summarizeStatus(res)}`, {
              errors: res.errors,
              console: res.console,
            });
      }),
    { annotations: { title: 'Compile SCO class', readOnlyHint: false } },
  );

  return [importClass, compileClass];
}
