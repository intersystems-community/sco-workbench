import type { CubeDefinition, CubeDimension, HierarchyDef, LevelDef, CubeMeasure } from './cube-definition.model.js';

/**
 * Parse a cube class's `.cls` source (as read from IRIS via the Atelier API)
 * back into a CubeDefinition, so the Workbench can EDIT a cube it previously
 * created. The runtime D2CLIENT Info API does NOT expose the editable fields
 * (sourceProperty, aggregate, timeFunction) — only the class definition does —
 * so we read the class and parse its `XData Cube` XML.
 *
 * Scope: the "Core + multi-level hierarchies" feature set the Workbench form
 * supports — cube name/source/description, measures (name, source
 * property/expression, aggregate, type, factName, displayName), and dimensions
 * with multiple hierarchies each having multiple levels (source
 * property/expression, timeFunction, nullReplacement, sort, displayName). Other
 * elements the generator can emit (relationships, calculatedMembers, listings,
 * properties) are preserved only insofar as the form round-trips them; anything
 * unsupported is ignored by the parser (and thus dropped on re-save — the UI
 * warns before editing a cube it didn't create).
 *
 * This is a pragmatic regex/attribute parser, not a full XML parser: the
 * generator emits a stable, double-quoted attribute format (see cube-generator),
 * and the parser is unit-tested to round-trip that exact output.
 */
export function parseCubeClass(source: string): CubeDefinition | null {
  const xdata = extractXData(source);
  if (!xdata) return null;

  const cubeTag = firstTag(xdata, 'cube');
  if (!cubeTag) return null;
  const cubeAttrs = parseAttrs(cubeTag.open);

  const cubeName = cubeAttrs['name'];
  const sourceClass = cubeAttrs['sourceClass'];
  if (!cubeName || !sourceClass) return null;

  const def: CubeDefinition = {
    cubeName,
    sourceClass,
    ...(cubeAttrs['displayName'] && cubeAttrs['displayName'] !== cubeName
      ? { displayName: cubeAttrs['displayName'] }
      : {}),
    ...(cubeAttrs['description'] ? { description: cubeAttrs['description'] } : {}),
    dimensions: parseDimensions(cubeTag.body),
    measures: parseMeasures(cubeTag.body),
  };
  return def;
}

// ---------- element parsers ----------

function parseDimensions(cubeBody: string): CubeDimension[] {
  const dims: CubeDimension[] = [];
  for (const dim of allTags(cubeBody, 'dimension')) {
    const a = parseAttrs(dim.open);
    if (!a['name']) continue;
    const type = (a['type'] as CubeDimension['type']) || 'data';
    // For time/age dimensions the generator hoists sourceProperty onto the
    // <dimension>; the edit form keeps it on the levels, so push it back down
    // so the form round-trips (mirrors buildDimension's hoist).
    const dimSource = (type === 'time' || type === 'age') ? a['sourceProperty'] : undefined;
    dims.push({
      name: a['name'],
      type,
      ...(a['displayName'] && a['displayName'] !== a['name'] ? { displayName: a['displayName'] } : {}),
      ...(a['hasAll'] !== undefined ? { hasAll: a['hasAll'] === 'true' } : {}),
      hierarchies: parseHierarchies(dim.body, dimSource),
    });
  }
  return dims;
}

function parseHierarchies(dimBody: string, dimSource?: string): HierarchyDef[] {
  const hiers: HierarchyDef[] = [];
  for (const h of allTags(dimBody, 'hierarchy')) {
    const a = parseAttrs(h.open);
    hiers.push({
      name: a['name'] || 'H1',
      ...(a['displayName'] ? { displayName: a['displayName'] } : {}),
      levels: parseLevels(h.body, dimSource),
    });
  }
  return hiers;
}

function parseLevels(hierBody: string, dimSource?: string): LevelDef[] {
  const levels: LevelDef[] = [];
  for (const l of allTags(hierBody, 'level')) {
    const a = parseAttrs(l.open);
    if (!a['name']) continue;
    // A time-dimension level has no own sourceProperty in the generated XData;
    // inherit the dimension's so the edit form shows the date field.
    const sourceProperty = a['sourceProperty'] ?? dimSource;
    const level: LevelDef = {
      name: a['name'],
      factNumber: Number(a['factNumber']) || 0,
      ...(a['displayName'] && a['displayName'] !== a['name'] ? { displayName: a['displayName'] } : {}),
      ...(sourceProperty ? { sourceProperty } : {}),
      ...(a['sourceExpression'] ? { sourceExpression: a['sourceExpression'] } : {}),
      ...(a['timeFunction'] ? { timeFunction: a['timeFunction'] as LevelDef['timeFunction'] } : {}),
      ...(a['nullReplacement'] ? { nullReplacement: a['nullReplacement'] } : {}),
    };
    levels.push(level);
  }
  return levels;
}

function parseMeasures(cubeBody: string): CubeMeasure[] {
  const measures: CubeMeasure[] = [];
  for (const m of allTags(cubeBody, 'measure')) {
    const a = parseAttrs(m.open);
    if (!a['name']) continue;
    measures.push({
      name: a['name'],
      factName: a['factName'] || sanitizeFact(a['name']),
      aggregate: (a['aggregate'] as CubeMeasure['aggregate']) || 'SUM',
      type: (a['type'] as CubeMeasure['type']) || 'number',
      factNumber: Number(a['factNumber']) || 0,
      ...(a['displayName'] && a['displayName'] !== a['name'] ? { displayName: a['displayName'] } : {}),
      ...(a['sourceProperty'] ? { sourceProperty: a['sourceProperty'] } : {}),
      ...(a['sourceExpression'] ? { sourceExpression: a['sourceExpression'] } : {}),
    });
  }
  return measures;
}

// ---------- low-level XML helpers ----------

/** Extract the body of the `XData Cube { ... }` block. */
function extractXData(source: string): string | null {
  const idx = source.search(/XData\s+Cube\b/);
  if (idx === -1) return null;
  const braceStart = source.indexOf('{', idx);
  if (braceStart === -1) return null;
  // Match to the matching closing brace of the XData block.
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  return null;
}

interface Tag {
  open: string; // the opening tag's attribute text (without < name or >)
  body: string; // inner content between open and close
}

/** Find the first `<name ...>...</name>` (or self-closing) and return it. */
function firstTag(xml: string, name: string): Tag | null {
  return allTags(xml, name)[0] ?? null;
}

/**
 * Return every direct-or-nested `<name ...> ... </name>` occurrence at the
 * SHALLOWEST level (non-overlapping): we scan for an opening `<name`, then find
 * its matching close accounting for same-name nesting. Good enough because the
 * cube grammar doesn't nest same-named elements (dimensions don't contain
 * dimensions, etc.).
 */
function allTags(xml: string, name: string): Tag[] {
  const tags: Tag[] = [];
  const openRe = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml))) {
    const attrText = m[1] ?? '';
    const selfClose = m[2] === '/';
    if (selfClose) {
      tags.push({ open: attrText, body: '' });
      continue;
    }
    // Find the matching close tag from here.
    const closeTag = `</${name}>`;
    const bodyStart = openRe.lastIndex;
    const closeIdx = xml.indexOf(closeTag, bodyStart);
    if (closeIdx === -1) {
      tags.push({ open: attrText, body: '' });
      break;
    }
    tags.push({ open: attrText, body: xml.slice(bodyStart, closeIdx) });
    openRe.lastIndex = closeIdx + closeTag.length;
  }
  return tags;
}

/** Parse double-quoted attributes from an opening-tag attribute string. */
function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText))) {
    attrs[m[1]!] = unescapeXml(m[2]!);
  }
  return attrs;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function sanitizeFact(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '');
  return cleaned || 'Measure';
}
