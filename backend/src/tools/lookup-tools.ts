import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { IrisServices } from '../iris/index.js';
import { listCubes, cubeDetail, cubeStructure, readCubeDefinitionForDisplay } from '../iris/cube-catalog-ops.js';
import { countRows } from '../iris/row-count-ops.js';
import type { CubeMemberReader } from '../dashboard/chart-data.js';
import { DeepSeeShapeAdapter } from '../dashboard/cube-shape.js';
import { DeepSeeMemberReader } from '../dashboard/cube-members.js';
import { ok, guard } from './result.js';

/**
 * The default cube-member reader: the SAME DeepSeeMemberReader + shape adapter the
 * Dashboard's /cube-members route uses (see dashboard-routes.ts). Sharing the one
 * port is the point — a member the assistant looks up for a KPI condition is read
 * exactly as the MDX-builder datalist reads it, so its `&[key]` matches a
 * builder-placed member byte-for-byte instead of being a humanized guess.
 */
function defaultMemberReader(iris: IrisServices): CubeMemberReader {
  const shapeReader = new DeepSeeShapeAdapter(iris.deepsee, iris.atelier);
  return new DeepSeeMemberReader(shapeReader, iris.deepsee);
}

/**
 * Read-only DISCOVERY tools: "what exists?" and "what does it look like?".
 *
 * The other read tools all take a name — you must already know what you are asking
 * about. These are the ones that let the assistant find out, which is what makes it
 * able to answer about something that is NOT on the user's current page. Without
 * `sco_list_cubes` it cannot say which cubes exist; without `sco_list_data_objects`
 * it cannot enumerate the data model; without `sco_cube_detail` it cannot name a
 * cube's real measures and dimensions (and so cannot help pick one for a KPI).
 *
 * All are strictly read-only and therefore available in Guided mode as well as Agent
 * mode — see CONTEXT_LOOKUP_TOOLS in ./index.ts.
 */
export function lookupTools(iris: IrisServices, memberReader: CubeMemberReader = defaultMemberReader(iris)) {
  const cubes = tool(
    'sco_list_cubes',
    'List every cube defined in the namespace: its cube name, class name, and the source class it reads. ' +
      'Use this to discover what cubes exist — before proposing a new one (there may already be a cube on that ' +
      'source class), to find the cube behind a KPI, or to answer "which cubes do we have?" from ANY page. ' +
      'Read-only.',
    {},
    async () =>
      guard(async () => {
        const list = await listCubes(iris.atelier);
        return ok({ cubes: list, count: list.length });
      }),
    { annotations: { title: 'List cubes', readOnlyHint: true } },
  );

  const detail = tool(
    'sco_cube_detail',
    "Read ONE cube's full structure: its source class, whether it is built and how many facts it holds, its " +
      'MEASURES, and its DIMENSIONS with their hierarchies and levels (including each level\'s source property or ' +
      'expression). This is the tool for "what can I break this cube down by?" / "which measures does it have?" — ' +
      'the names a KPI must reference are here, so read them rather than guessing. Accepts a cube name or its ' +
      'class name. Read-only. (`sco_cube_info` only answers exists/factCount; use this when you need the shape.)',
    { cubeName: z.string().describe('Cube name (e.g. "SalesOrderCube") or its full class name.') },
    async ({ cubeName }) =>
      guard(async () => {
        const base = await cubeDetail(iris.native, iris.atelier, cubeName);
        // Only a BUILT/compiled cube has a live structure to read. Feed the compiled
        // definition in so each level's source property/expression is included — the
        // D2CLIENT Info API alone doesn't expose those (same composition the cube
        // route uses for the detail page).
        if (!base.exists) return ok({ ...base, measures: [], dimensions: [], listings: [] });
        const definition = await readCubeDefinitionForDisplay(iris.atelier, cubeName).catch(() => null);
        const structure = await cubeStructure(iris.deepsee, base.cubeName ?? cubeName, definition);
        return ok({ ...base, ...structure });
      }),
    { annotations: { title: 'Cube detail', readOnlyHint: true } },
  );

  const members = tool(
    'sco_cube_members',
    "List the REAL member VALUES of one cube dimension level — each member's display name and its MDX " +
      'KEY. Use this BEFORE writing any KPI condition that pins a member: a condition is ' +
      '`[dimension].[hierarchy].[level].&[key]`, and the `&[key]` MUST be a real key from this list — ' +
      'never the level name humanized or guessed. `sco_cube_detail` gives you the dimensions and their ' +
      'levels (with each level\'s MDX spec); pass that spec as `level` here to read that level\'s members. ' +
      'Omit `level` to read the dimension\'s first level. When you need the user to choose a member, offer ' +
      'these real members as the options (they can always type their own). Read-only.',
    {
      cube: z.string().describe('Cube name (e.g. "ProductInventoryCube") or its full class name.'),
      dimension: z
        .string()
        .describe('The dimension NAME as sco_cube_detail lists it (e.g. "productBrand"), not its MDX spec.'),
      level: z
        .string()
        .optional()
        .describe(
          'Optional level MDX spec to target a specific level of a multi-level dimension ' +
            '(e.g. "[productBrand].[H1].[brand]", copied from sco_cube_detail). Omit for the first level.',
        ),
    },
    async ({ cube, dimension, level }) =>
      guard(async () => {
        const list = await memberReader.members(cube, dimension, level);
        return ok({ cube, dimension, level: level ?? null, members: list, count: list.length });
      }),
    { annotations: { title: 'Cube members', readOnlyHint: true } },
  );

  const objects = tool(
    'sco_list_data_objects',
    'List every object in the SCO data model — the same list the Data Model page shows, including custom objects. ' +
      'Use this to discover what data exists before answering a modelling question, choosing a cube source class, ' +
      'or picking an integration target class, and to answer "what objects do we have?" from ANY page. Read-only.',
    {},
    async () =>
      guard(async () => {
        const list = await iris.scmodel.listObjects();
        return ok({ objects: list, count: list.length });
      }),
    { annotations: { title: 'List data-model objects', readOnlyHint: true } },
  );

  const object = tool(
    'sco_get_data_object',
    "Read ONE SCO data-model object as the Data Model page shows it: its attributes with data types and required " +
      'flags, and its relationships to other objects. Use this when the user asks about an object that is NOT the ' +
      'one on screen (e.g. they are looking at Customer and ask what Sales Order holds) — answer in place rather ' +
      'than navigating them away. Returns found:false if there is no such object, with nothing invented. ' +
      'Read-only. (For the raw compiled-class view, incl. which properties are references, use sco_list_properties.)',
    { objectName: z.string().describe('The object name as the data model lists it, e.g. "SalesOrder".') },
    async ({ objectName }) =>
      guard(async () => {
        const found = await iris.scmodel.getObject(objectName);
        if (found === null || found === undefined) return ok({ objectName, found: false });
        return ok({ objectName, found: true, object: found });
      }),
    { annotations: { title: 'Get data-model object', readOnlyHint: true } },
  );

  const rowCount = tool(
    'sco_row_count',
    'Count the rows stored for a class or SQL table (accepts either form, e.g. "SC.Data.SalesOrder" or ' +
      '"SC_Data.SalesOrder"). Use it to answer "how much data is there?", to sanity-check a source class before ' +
      'building a cube on it, or to explain why a built cube has no facts (an empty source). Read-only.',
    { name: z.string().describe('Class name or SQL schema.table name.') },
    async ({ name }) =>
      guard(async () => {
        const r = await countRows(iris.atelier, name);
        return ok({ ...r });
      }),
    { annotations: { title: 'Count rows', readOnlyHint: true } },
  );

  return [cubes, detail, members, objects, object, rowCount];
}
