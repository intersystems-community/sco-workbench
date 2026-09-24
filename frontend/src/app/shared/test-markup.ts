/**
 * Markup helpers for snapshot tests (imported by *.spec.ts only).
 */

/**
 * Strip Angular's per-component style-scope attribute (`_ngcontent-a-c123456789`)
 * out of rendered markup.
 *
 * The scope id is a hash Angular derives from the component definition, so it
 * changes whenever the component class is edited — even by an edit that touches no
 * template at all. A snapshot that pins the raw outerHTML therefore reddens for
 * reasons that have nothing to do with the markup, which is the opposite of what
 * the dedup-guard snapshots are for: they pin the form region's class list and
 * structure. Normalising the attribute away keeps them honest.
 */
export function styleScopeFree(html: string | undefined): string {
  return (html ?? '').replace(/ _ngcontent-[^=]+=""/g, '');
}
