import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { UiControlBroker } from '../server/ui-control.js';
import { ok, fail, guard } from './result.js';

/**
 * UI-directive tools for **Guided mode** — the "teacher" persona.
 *
 * These do NOT touch IRIS. They drive the Angular workbench so the assistant can
 * teach by doing: switch to a feature page, open its create form, pre-fill a
 * field, or highlight an element. Each emits a `ui_directive` SSE event via the
 * UiControlBroker; the frontend applies it to the live component.
 *
 * In Agent mode these are denied by the permission gate (canUseTool) — Agent
 * mode works directly against IRIS and never manipulates the UI. Conversely, in
 * Guided mode the `sco_*` tools are denied, so the assistant can only guide.
 *
 * The effect of a directive is observed on the NEXT turn's UI-context block
 * (which reports the page + filled fields), so these calls are fire-and-forget.
 */

/**
 * The `feature` (page) argument of `ui_navigate` / `ui_open_form`.
 *
 * Deliberately a free string, NOT an enum: the workbench's pages change as the
 * product grows, and a list baked in here went stale — it offered a page that no
 * longer existed and hid several that did, so the assistant told users the
 * workbench had pages it didn't and couldn't reach the ones it had. The live list
 * is reported by the frontend in every turn's UI CONTEXT (`availablePages`,
 * derived from the rendered sidebar), and the frontend REJECTS a key that isn't in
 * it — the refusal carries the real page list, so a wrong key corrects itself
 * instead of silently switching to a view that renders nothing.
 */
const featureArg = z
  .string()
  .min(1)
  .describe(
    'The page key, taken from the `availablePages` list in this turn\'s UI CONTEXT (e.g. "bi-cubes" for ' +
      'Analytics Cubes, "kpi" for Business KPIs). That list is the workbench as it stands right now — never ' +
      'use a key from memory or invent one; a key that is not listed is refused and the pages are returned.',
  );

/**
 * The ONLY elements that can be highlighted — each corresponds to an `[axGuide]`
 * anchor in the Angular templates. `ui_highlight` accepts nothing else (the enum
 * both advertises the allow-list to the model and rejects invalid calls at the
 * schema layer), so the assistant never "highlights" something that can't light
 * up. For anything not in this list, the assistant should describe it in words
 * instead of calling this tool.
 *
 * Which ids are actually on screen depends on the page/view:
 *   Cubes detail:  new-cube, edit-cube, dimensions, measures
 *   Cubes form:    name, save-draft-button, compile-button, build-button, cancel-button
 *   KPIs detail:   new-kpi, edit-kpi
 *   KPIs form:     name, save-draft-button, submit-button, cancel-button
 *   Data Integration detail: new-integration, edit-integration, deploy-button
 *   Data Integration wizard: name, sourceType, next-button (step 1);
 *     sourceHasHeader, targetClass, add-column-button, auto-map-button, create-button (step 2).
 *     A field the assistant just filled (e.g. a source-config field or "columns.0.name")
 *     can also be highlighted by its ui_set_field path while that step is visible.
 *   Data Model list/detail: add-object-button, add-attribute-button
 *   Data Model object form: objectName, save-object-button, cancel-object-button
 *   Data Model attribute form: name, save-attribute-button, cancel-attribute-button
 *     A field the assistant just filled (e.g. "attributes.0.name" or "dataType")
 *     can also be highlighted by its ui_set_field path while that form is visible.
 */
const HIGHLIGHT_TARGETS = [
  'new-cube',
  'edit-cube',
  'dimensions',
  'measures',
  'save-draft-button',
  'compile-button',
  'build-button',
  'new-kpi',
  'edit-kpi',
  'submit-button',
  'cancel-button',
  'name',
  // Data-integration wizard
  'new-integration',
  'edit-integration',
  'create-pipeline-button',
  'deploy-button',
  'sourceType',
  'targetClass',
  'sourceHasHeader',
  'add-column-button',
  'auto-map-button',
  'next-button',
  'create-button',
  // Data-model (Resources) page
  'add-object-button',
  'add-attribute-button',
  'objectName',
  'save-object-button',
  'cancel-object-button',
  'save-attribute-button',
  'cancel-attribute-button',
] as const;

export function uiTools(broker: UiControlBroker) {
  const navigate = tool(
    'ui_navigate',
    [
      'Guided mode only. Switch the workbench to a feature page so the user sees it.',
      'Use before explaining or filling a form that lives on another page (e.g. navigate to "bi-cubes"',
      'before helping build a cube). This changes only the local UI, not SCO.',
      'The result includes the destination page\'s CURRENT CONTEXT — for a list page that is the full',
      'detail of every item on it — so you can immediately resolve and open the item the user asked for',
      'IN THIS SAME TURN, without waiting for a later turn or asking the user to find it.',
      'If the result reports the CURRENT page has UNSAVED CHANGES, do not retry blindly: ask the user',
      'whether to save a draft or discard, then call this again with `onUnsaved` set — you resolve it for',
      'them (save-draft or discard) and then navigate; never make the user click a dialog.',
      'The pages you may pass are the ones listed under `availablePages` in this turn\'s UI CONTEXT — the',
      'workbench reports its live sidebar there, so read them from it rather than assuming a fixed set.',
    ].join(' '),
    {
      feature: featureArg,
      onUnsaved: z
        .enum(['save', 'discard'])
        .optional()
        .describe(
          'How to handle unsaved edits on the CURRENT page so this navigation can proceed. Omit on the first ' +
            'attempt; if the result says there are unsaved changes, ask the user, then retry with "save" ' +
            '(persist the current form as a draft first) or "discard" (drop the edits). You perform it for the ' +
            'user — do not ask them to click the leave dialog.',
        ),
    },
    async ({ feature, onUnsaved }) =>
      guard(async () => {
        // The frontend switches the page, waits for its list to load, and returns
        // the destination page's context in `detail` — so we relay that to the
        // assistant and it can act on the list within this turn. `onUnsaved`, when
        // set, tells the frontend to save-draft/discard the current form first so
        // the navigation isn't blocked.
        const res = await broker.send({
          action: 'navigate',
          target: feature,
          value: onUnsaved ? { onUnsaved } : undefined,
        });
        // Navigate is tolerant of a lost ack (a timeout still returns ok — the page
        // switch is best-effort). The meaningful signals (destination snapshot, an
        // unsaved-edits block asking you to retry with onUnsaved, or an unknown page
        // key answered with the real page list) ride in `context`, so relay
        // res.detail there rather than failing the tool. `applied` reports whether
        // the UI confirmed the switch, so a refusal never reads as a success.
        return ok({ navigated: feature, applied: res.applied, context: res.detail });
      }),
    { annotations: { title: 'Navigate the UI', readOnlyHint: true } },
  );

  const openForm = tool(
    'ui_open_form',
    [
      'Guided mode only. Navigate to a feature page (going there first if needed) and open a form or land on',
      'an entity. You navigate the user yourself — never ask them to switch pages or click a list item.',
      'This tool OPENS THE FORM ITSELF: the "New …" button is clicked FOR the user as part of this call, so',
      'after it returns applied:true the create form is already on screen. Do NOT then highlight the "New"',
      'button or ask the user to click it — go straight to explaining/filling fields. The result `detail`',
      'includes the now-open form\'s context so you can start in the SAME turn.',
      '',
      'Modes:',
      '• NEW form (omit `entity`): opens an empty create form. Use for creating a new cube, KPI, or object.',
      '  For data-model, `formKind` picks which: "object" (default — a new custom object) or "attribute"',
      '  (add a custom attribute — pass the object in `entity` too so it gets selected first).',
      '• EXISTING entity (pass `entity`): land on something that already exists, by name. `mode` decides how:',
      '  - "view" (DEFAULT): just navigate + select the item to show its detail/definition. Use this when the',
      '    user only wants to SEE something (e.g. "show me the cube behind this KPI"). Works for ANY item,',
      '    including built-in SCO cubes that cannot be edited.',
      '  - "edit": reopen the item in its edit form. On kpi/bi-cubes this only works for the user\'s OWN',
      '    SAVED DRAFT — use it to return them to a KPI/cube they were editing. It fails if the item has no',
      '    saved draft or is a non-editable built-in; on failure it stays on the detail view and tells you why,',
      '    so relay that to the user. For data-model, `formKind:"attribute"` opens the selected object\'s',
      '    Add Custom Attribute form.',
      '',
      'IMPORTANT: do not use "edit" just to show something — default to "view". Only edit when the user',
      'explicitly wants to change the item.',
      '',
      'Before navigating AWAY from a page where the user is editing a form: if this tool (or ui_navigate)',
      'reports the user has UNSAVED CHANGES, do not retry blindly. Ask the user whether to save a draft or',
      'discard, then call this tool again with `onUnsaved` set — you resolve it for them (save-draft or',
      'discard) and then proceed. Never tell the user to click a leave dialog themselves. Nothing is auto-saved.',
    ].join(' '),
    {
      feature: featureArg,
      formKind: z
        .enum(['object', 'attribute'])
        .optional()
        .describe(
          'Data-model only: "object" (default) opens the new-object form; "attribute" opens the ' +
            'add-attribute form for the object named by `entity`. Omit for other features.',
        ),
      entity: z
        .string()
        .optional()
        .describe(
          'Name of an EXISTING entity to land on instead of a new form: a data-model object, or a KPI/cube ' +
            'to view or (if a saved draft) edit. Omit to open a fresh new form.',
        ),
      mode: z
        .enum(['view', 'edit'])
        .optional()
        .describe(
          'How to land on `entity`: "view" (default) selects it and shows its detail (works for any item, ' +
            'including non-editable built-ins); "edit" reopens it in its edit form (kpi/cube: saved drafts only). ' +
            'Ignored when `entity` is omitted.',
        ),
      onUnsaved: z
        .enum(['save', 'discard'])
        .optional()
        .describe(
          'How to handle unsaved edits on the CURRENT page so this open can proceed. Omit on the first attempt; ' +
            'if the result says there are unsaved changes, ask the user, then retry with "save" (persist the ' +
            'current form as a draft first) or "discard" (drop the edits). You perform it for the user — do not ' +
            'ask them to click the leave dialog.',
        ),
    },
    async ({ feature, formKind, entity, mode, onUnsaved }) =>
      guard(async () => {
        const name = entity?.trim();
        if (name) {
          const res = await broker.send({
            action: 'open_entity',
            target: feature,
            value: { name, mode: mode ?? 'view', ...(formKind ? { formKind } : {}), ...(onUnsaved ? { onUnsaved } : {}) },
          });
          if (res.applied === false) {
            return fail(
              res.detail || `Could not open "${name}" on ${feature}.`,
              { openedEntity: name, feature, mode: mode ?? 'view', applied: false },
            );
          }
          return ok({ openedEntity: name, feature, mode: mode ?? 'view', formKind, detail: res.detail });
        }
        const res = await broker.send({
          action: 'open_form',
          target: feature,
          value: formKind || onUnsaved ? { ...(formKind ? { formKind } : {}), ...(onUnsaved ? { onUnsaved } : {}) } : undefined,
        });
        if (res.applied === false) {
          return fail(res.detail || `Could not open the ${feature} form.`, { feature, applied: false });
        }
        // Forward the frontend's detail (the now-open form's context) so the agent
        // knows the form is really open and starts filling it THIS turn, instead
        // of highlighting the "New" button and asking the user to click it.
        return ok({ openedForm: feature, formKind, detail: res.detail });
      }),
    { annotations: { title: 'Open a form', readOnlyHint: true } },
  );

  const setField = tool(
    'ui_set_field',
    [
      'Guided mode only. Pre-fill ONE field of the currently open form for the user (they still review and',
      'click Save/Submit). Fill fields one at a time and explain each in your reply. `path` is a dotted field',
      'path into the form model, e.g. "name", "sourceClass", "dimensions.0.name", "kpiConditions.0",',
      '"valueType". Use ONLY a path the open form lists in its UI-CONTEXT `validFieldPaths` — do not invent',
      'nested backend paths (e.g. "deepseeKpiSpec" / "kpiDimensions" are NOT form paths). For a dropdown-backed',
      'field, pass the real option value from the UI CONTEXT (e.g. a KPI dimension is an MDX member like',
      '"[customer].[H1].[country]", not "country"); the form fuzzy-matches a plain term but PREFER the exact',
      'option. On a match against several options the result reports them so you can ask; on no match it lists',
      'the valid options. DEPENDENT dropdowns: when you set a parent (a KPI `cube`, a cube `sourceClass`) the',
      'RESULT `detail` returns the now-unlocked child options (measures/dimensions/properties) — read them and',
      'fill the child fields in the SAME turn. This changes only the local form, not SCO.',
    ].join(' '),
    {
      path: z.string().describe('Dotted field path into the active form, e.g. "name" or "dimensions.0.name".'),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .describe('The value to place in the field.'),
    },
    async ({ path, value }) =>
      guard(async () => {
        // The frontend reports whether the value actually landed. A select or
        // checkbox whose value matches no option can't be applied — report that
        // truthfully so the assistant doesn't claim a field was set when it
        // wasn't (e.g. an aggregate/type the dropdown doesn't offer).
        const res = await broker.send({ action: 'set_field', target: path, value });
        // A lost/timed-out ack now arrives here as applied:false (the broker resolves
        // a timeout/disconnect as a failure, not an empty result), so it correctly
        // routes to fail(...). Do not "restore" an empty-result success path.
        if (res.applied === false) {
          return fail(
            res.detail ||
              `Could not set "${path}" to ${JSON.stringify(value)} — the field rejected that value ` +
                `(for a dropdown, the value must match one of its options exactly).`,
            { setField: path, value, applied: false },
          );
        }
        return ok({ setField: path, value, applied: true, detail: res.detail });
      }),
    { annotations: { title: 'Fill a field', readOnlyHint: true } },
  );

  const reportStatus = tool(
    'ui_report_status',
    [
      'Agent mode. Report the REAL outcome of a deploy/delete step back to the workbench so a',
      "feature's status badge reflects what actually happened — not an optimistic guess. Call this after",
      'you finish (or fail) a data-integration pipeline lifecycle step that a UI button handed you. Deploy',
      'is a single automatic action (compile the classes → register the hosts → enable/start the pipeline):',
      'report phase "deployed" once ALL of that has succeeded, or "deleted" once the pipeline\'s items are',
      'removed. (The "created" phase is legacy — the current Deploy reports only "deployed".) Pass ok:false',
      'with a short detail if the step failed, so the UI can revert the badge and surface the error. The',
      '`target` is the integration id given in the prompt. This changes only the local UI, never SCO.',
    ].join(' '),
    {
      target: z.string().describe('The entity id whose status to update, e.g. the data-integration pipeline id from the prompt.'),
      phase: z
        .enum(['created', 'deployed', 'deleted'])
        .describe('The lifecycle phase reached: deployed (classes compiled + hosts registered + pipeline started) or deleted (items removed). "created" is a legacy phase kept for compatibility.'),
      ok: z.boolean().describe('Whether the step succeeded. Pass false if it failed or was aborted.'),
      detail: z.string().optional().describe('A short human-readable note (especially on failure) shown to the user.'),
    },
    async ({ target, phase, ok: succeeded, detail }) =>
      guard(async () => {
        await broker.send({ action: 'report_status', target, value: { phase, ok: succeeded, detail } });
        return ok({ reported: target, phase, ok: succeeded });
      }),
    { annotations: { title: 'Report status to the UI', readOnlyHint: true } },
  );

  const highlight = tool(
    'ui_highlight',
    [
      "Guided mode only. Put a pulsing ring on ONE specific UI element to draw the user's eye.",
      'Only the fixed set of ids in `target` can be highlighted — there is no way to highlight anything else',
      '(e.g. a specific dimension row, the source-class field, or the cube-name heading on the detail view).',
      'If what you want to point at is NOT one of these ids, do NOT call this tool — just describe the element',
      'in words instead (e.g. "look at the Source Class row in the Cube Properties card"). Only highlight an id',
      'that is actually visible on the current page/view: on the Cubes detail view use new-cube / edit-cube /',
      'dimensions / measures; in the cube form use name / save-draft-button / compile-button / build-button /',
      'cancel-button; on the KPIs detail view use new-kpi / edit-kpi; in the KPI form use name /',
      'save-draft-button / submit-button / cancel-button. The ring stays until the user clicks something.',
    ].join(' '),
    {
      target: z
        .enum(HIGHLIGHT_TARGETS)
        .describe(
          'The element to highlight. MUST be one of the allowed ids; if the thing you want to point at is not ' +
            'listed, describe it in words instead of calling this tool.',
        ),
    },
    async ({ target }) =>
      guard(async () => {
        await broker.send({ action: 'highlight', target });
        return ok({ highlighted: target });
      }),
    { annotations: { title: 'Highlight an element', readOnlyHint: true } },
  );

  return [navigate, openForm, setField, highlight, reportStatus];
}

/**
 * Bare names of the Guided-mode-only UI-directive tools. These drive the form
 * and are DENIED in Agent mode (see the permission gate). `ui_report_status` is
 * deliberately NOT here — it is an Agent-mode tool (the worker reports outcomes
 * back to the UI), so it must remain allowed when the others are blocked.
 */
export const UI_TOOL_NAMES = ['ui_navigate', 'ui_open_form', 'ui_set_field', 'ui_highlight'] as const;

/** The Agent-mode UI tool: reports a lifecycle step's real outcome to the workbench. */
export const UI_REPORT_STATUS_TOOL = 'ui_report_status';
