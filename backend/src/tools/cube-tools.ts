import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { IrisServices } from '../iris/index.js';
import { generateCubeClass, cubeClassName, validateCubeDefinition } from '../cube/cube-generator.js';
import type { CubeDefinition } from '../cube/cube-definition.model.js';
import { buildCube, cubeInfo } from '../iris/cube-ops.js';
import { collectBuildErrors, formatBuildErrorMessage } from '../iris/cube-build-errors.js';
import { ok, fail, guard } from './result.js';

// Zod schema mirroring the CubeDefinition model. Kept permissive (passthrough on
// nested objects) so the model can supply the rich attribute set the generator
// understands, while still validating the required scaffold.
const levelSchema = z.looseObject({ name: z.string(), factNumber: z.number().int() });
const hierarchySchema = z.looseObject({
  name: z.string().optional(),
  levels: z.array(levelSchema),
});
const dimensionSchema = z.looseObject({
  name: z.string(),
  type: z.enum(['data', 'time', 'age', 'computed', 'iKnow']),
  hierarchies: z.array(hierarchySchema),
});
const measureSchema = z.looseObject({
  name: z.string(),
  factName: z.string(),
  aggregate: z.enum(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX']),
  type: z.enum(['integer', 'number', 'boolean', 'string', 'date', 'age', 'text', 'iKnow']),
  factNumber: z.number().int(),
});

const cubeDefinitionSchema = z.looseObject({
  cubeName: z.string().describe('Cube name (also the class name segment, no package).'),
  sourceClass: z.string().describe('Fully-qualified source %Persistent class, e.g. "Workbench.Test.Source".'),
  description: z.string().optional(),
  dimensions: z.array(dimensionSchema).optional(),
  measures: z.array(measureSchema).optional(),
});

export function cubeTools(iris: IrisServices) {
  // Read-only: generate the .cls text without touching IRIS.
  const generate = tool(
    'sco_generate_cube_cls',
    'Generate the ObjectScript .cls source for an SCO analytics cube from a cube definition. Does NOT touch SCO — returns the class name and source text for review, then compile with sco_compile_class. Every factNumber must be unique and start at 2.',
    { definition: cubeDefinitionSchema },
    async ({ definition }) =>
      guard(() => {
        const def = definition as unknown as CubeDefinition;
        const problems = validateCubeDefinition(def);
        if (problems.length) return fail(`Invalid cube definition:\n${problems.join('\n')}`, { problems });
        const source = generateCubeClass(def);
        return ok({ className: cubeClassName(def.cubeName), source });
      }),
    { annotations: { title: 'Generate cube .cls', readOnlyHint: true } },
  );

  // State-changing: populate the cube.
  const build = tool(
    'sco_build_cube',
    'Build (populate) an already-compiled SCO analytics cube from its source table using %DeepSee.Utils.%BuildCube. Returns the fact count. Changes the SCO instance.',
    { cubeName: z.string().describe('The cube name (matches the <cube name=...>, not the class name).') },
    async ({ cubeName }) =>
      guard(async () => {
        const res = buildCube(iris.native, cubeName);
        if (res.ok) return ok({ cubeName, factCount: res.factCount, message: res.message });
        // Surface the real per-row build errors (deduped), never IRIS's
        // "run %PrintBuildErrors yourself" pointer.
        const summary = await collectBuildErrors(iris, cubeName);
        const message = summary && summary.samples.length ? formatBuildErrorMessage(cubeName, summary) : res.message;
        return fail(message, summary ? { total: summary.total, distinct: summary.distinct, samples: summary.samples } : {});
      }),
    { annotations: { title: 'Build cube', readOnlyHint: false } },
  );

  // Read-only: inspect the cube.
  const info = tool(
    'sco_cube_info',
    'Inspect an SCO analytics cube: whether it exists and its current fact count. Read-only.',
    { cubeName: z.string() },
    async ({ cubeName }) =>
      guard(() => {
        const res = cubeInfo(iris.native, cubeName);
        return ok({ ...res });
      }),
    { annotations: { title: 'Cube info', readOnlyHint: true } },
  );

  return [generate, build, info];
}
