/**
 * Tool-call label & result formatting for the assistant timeline.
 *
 * Ported verbatim (behavior-for-behavior) from the standalone chat UI so the
 * embedded assistant describes IRIS tool calls exactly as before.
 */

export function shortName(name: string): string {
  return name.replace(/^mcp__sco__/, '');
}

/** The invoked skill's name from the Skill tool input, if present. */
export function skillName(input: unknown): string | undefined {
  const i = input as { command?: string; name?: string; skill?: string } | null;
  return i?.command ?? i?.name ?? i?.skill ?? undefined;
}

export function describeTool(name: string, input: any): string {
  switch (shortName(name)) {
    case 'sco_resolve_class':
      return `Resolving class ${input?.name ?? ''}`;
    case 'sco_list_properties':
      return `Listing properties of ${input?.className ?? ''}`;
    case 'sco_match_property':
      return `Matching property "${input?.requested ?? ''}"`;
    case 'sco_generate_cube_cls':
      return 'Generating cube .cls';
    case 'sco_compile_class':
      return `Compiling ${input?.className ?? 'class'}`;
    case 'sco_import_class':
      return `Importing ${input?.className ?? 'class'}`;
    case 'sco_build_cube':
      return `Building cube ${input?.cubeName ?? ''}`;
    case 'sco_cube_info':
      return `Inspecting cube ${input?.cubeName ?? ''}`;
    case 'sco_production_status':
      return 'Reading production status';
    case 'sco_add_config_item':
      return `Adding ${input?.className ?? 'item'} to production`;
    case 'sco_enable_config_item':
      return `${input?.enabled === false ? 'Disabling' : 'Enabling'} ${input?.name ?? 'item'}`;
    case 'sco_update_production':
      return 'Applying production changes';
    default:
      return `Running ${shortName(name)}`;
  }
}

/** The last path segment of a file path (e.g. "…/skills/data-model/SKILL.md" → "SKILL.md"). */
export function baseName(path: string): string {
  const clean = path.replace(/[/\\]+$/, '');
  const seg = clean.split(/[/\\]/).pop();
  return seg && seg.length ? seg : clean;
}

/** The short one-line label for a tool/skill step row. */
export function stepLabel(name: string, input: any): string {
  if (name === 'Skill') {
    return `Skill: ${input?.command ?? input?.name ?? 'skill'}`;
  }
  // Built-in file tools: show the short file name, not the full path.
  if (name === 'Read' && input?.file_path) {
    return `Read ${baseName(String(input.file_path))}`;
  }
  return describeTool(name, input);
}

/**
 * Tools whose RESULT should not be previewed inline (summary + expandable
 * output). `Read` returns the whole file, which flooded the timeline with file
 * contents; the file name is already in the step label, so the result adds
 * nothing useful.
 */
const NO_RESULT_PREVIEW = new Set(['Read']);

/** Whether a tool's result should be shown (summary line + details disclosure). */
export function showsResultPreview(name: string): boolean {
  return !NO_RESULT_PREVIEW.has(name);
}

/** The disclosure-toggle label (skill name, or short tool name). */
export function stepToolName(name: string, input: unknown): string {
  return name === 'Skill' ? (skillName(input) ?? 'skill') : shortName(name);
}

export function summarizeToolResult(text: string): string {
  try {
    const p = JSON.parse(text);
    if (p.error) return String(p.error).split('\n')[0];
    if (p.className && p.source) return `Generated ${p.className}`;
    if (typeof p.factCount === 'number') return `${p.factCount} facts`;
    if (p.exists === true && p.className) return `→ ${p.className}`;
    if (p.exists === false) return 'not found';
    if (Array.isArray(p.properties)) return `${p.properties.length} properties`;
    if (p.message) return String(p.message).split('\n')[0];
    return '';
  } catch {
    return text.slice(0, 120);
  }
}

export function prettyToolResult(text: string): string {
  try {
    const p = JSON.parse(text);
    if (typeof p.source === 'string') {
      const { source, ...rest } = p;
      const head = Object.keys(rest).length ? JSON.stringify(rest, null, 2) + '\n\n' : '';
      return head + source;
    }
    return JSON.stringify(p, null, 2);
  } catch {
    return text;
  }
}

export function pretty(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Return true if the tool input has any renderable content for the disclosure. */
export function hasInput(input: unknown): boolean {
  return input !== undefined && input !== null && Object.keys(input as object).length > 0;
}
