import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Component, Type, ViewEncapsulation } from '@angular/core';

// Focus-ring coverage guard (WCAG 2.4.7).
//
// The uniform-light slice added a standard keyboard focus ring —
//   outline: 2px solid var(--db-focus); outline-offset: 2px;
// — to every control that suppresses the UA outline. This spec proves those rings are
// actually PRESENT in the shipped CSS, so a future edit that deletes a ring (or drops the
// --db-focus token) turns this suite red.
//
// It reads the REAL committed stylesheets, not a hand-maintained list: each host component
// loads one sheet via `styleUrl` under ViewEncapsulation.None, which makes Angular's own style
// loader inject that CSS VERBATIM (unscoped — no _ngcontent hash) into the DOM as a <style>
// element. We then read its CSSOM. jsdom preserves var() inside the outline shorthand and parses
// multi-line + grouped (comma) rules, so each selector can be bound to its own ring rule.
// (`?raw` bundles as a JS module and node:fs won't compile under @angular/build — hence this
// route, which is the one that actually reads the file.)

@Component({ standalone: true, template: '<i></i>', styleUrl: './kpi/kpi.css', encapsulation: ViewEncapsulation.None })
class KpiSheet {}
@Component({ standalone: true, template: '<i></i>', styleUrl: './bi-cubes/bi-cubes.css', encapsulation: ViewEncapsulation.None })
class BiCubesSheet {}
@Component({ standalone: true, template: '<i></i>', styleUrl: './data-integration/data-integration.css', encapsulation: ViewEncapsulation.None })
class DataIntegrationSheet {}
@Component({ standalone: true, template: '<i></i>', styleUrl: './assistant/assistant-modals.css', encapsulation: ViewEncapsulation.None })
class AssistantModalsSheet {}
@Component({ standalone: true, template: '<i></i>', styleUrl: './assistant/assistant-panel.css', encapsulation: ViewEncapsulation.None })
class AssistantPanelSheet {}
@Component({ standalone: true, template: '<i></i>', styleUrl: './dashboard/tile-editor.css', encapsulation: ViewEncapsulation.None })
class TileEditorSheet {}
@Component({ standalone: true, template: '<i></i>', styleUrl: './dashboard/confirm-dialog.css', encapsulation: ViewEncapsulation.None })
class ConfirmDialogSheet {}

const FOCUS_TOKEN = 'var(--db-focus)';

// Every CSSStyleRule from every injected <style>, flattened.
function styleRules(): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  for (const st of Array.from(document.querySelectorAll('style'))) {
    const sheet = (st as HTMLStyleElement).sheet;
    if (!sheet) continue;
    try {
      for (const r of Array.from(sheet.cssRules)) {
        if ((r as CSSStyleRule).selectorText !== undefined) out.push(r as CSSStyleRule);
      }
    } catch { /* defensive: local <style> CSSOM access does not throw here */ }
  }
  return out;
}

// Clear prior sheets, mount ONE host, return that sheet's CSS rules. Each host is mounted exactly
// once per assertion so Angular always injects fresh (no cross-sheet bleed, no loader dedupe trap).
function mount(host: Type<unknown>): CSSStyleRule[] {
  Array.from(document.querySelectorAll('style')).forEach(s => s.remove());
  const fixture = TestBed.createComponent(host);
  fixture.detectChanges();
  return styleRules();
}

// The rule whose selector list contains exactly `<selector>:focus-visible` (handles grouped rules
// like `.a:focus-visible, .b:focus-visible` by matching a single comma-separated part).
function focusRule(rules: CSSStyleRule[], selector: string): CSSStyleRule | undefined {
  const needle = `${selector}:focus-visible`;
  return rules.find(r => r.selectorText.split(',').map(s => s.trim()).includes(needle));
}

// Assert `<selector>:focus-visible` declares the standard ring. Missing rule OR a ring that no
// longer uses the token / 2px solid / 2px offset all fail — that is the guard.
function expectStandardRing(rules: CSSStyleRule[], selector: string): void {
  const rule = focusRule(rules, selector);
  expect(rule, `no :focus-visible rule for ${selector}`).toBeTruthy();
  const outline = rule!.style.getPropertyValue('outline');
  const offset = rule!.style.getPropertyValue('outline-offset');
  expect(outline, `${selector} ring must use the ${FOCUS_TOKEN} token`).toContain(FOCUS_TOKEN);
  expect(outline, `${selector} ring must be 2px wide`).toMatch(/\b2px\b/);
  expect(outline, `${selector} ring must be solid`).toContain('solid');
  expect(offset, `${selector} ring must set outline-offset: 2px`).toBe('2px');
}

function baseRule(rules: CSSStyleRule[], selector: string): CSSStyleRule | undefined {
  return rules.find(r => r.selectorText.split(',').map(s => s.trim()).includes(selector));
}

describe('Focus ring coverage (WCAG 2.4.7)', () => {
  it('kpi.css: every focus-managed control has the standard ring', () => {
    const rules = mount(KpiSheet);
    for (const sel of [
      '.new-group-input',
      '.dim-select',
      '.condition-face',
      '.condition-level-select',
      '.condition-chip .condition-operator',
      '.condition-chip .condition-member-combobox',
      '.condition-chip .condition-measure-select',   // shares a grouped rule with the value input
      '.condition-chip .condition-value-input',
      '.condition-chip .condition-member-checkboxes > summary',
    ]) {
      expectStandardRing(rules, sel);
    }
  });

  it('bi-cubes.css: filter + chat inputs have the standard ring', () => {
    const rules = mount(BiCubesSheet);
    expectStandardRing(rules, '.filter-select');
    expectStandardRing(rules, '.chat-input');
  });

  it('data-integration.css: cell select + input have the standard ring', () => {
    const rules = mount(DataIntegrationSheet);
    expectStandardRing(rules, '.cell-select');
    expectStandardRing(rules, '.cell-input');
  });

  it('assistant-modals.css: the "other" input has the standard ring', () => {
    const rules = mount(AssistantModalsSheet);
    expectStandardRing(rules, '.ax-other__input');
  });

  it('assistant-panel.css: the history input has the standard ring', () => {
    const rules = mount(AssistantPanelSheet);
    expectStandardRing(rules, '.ax-history-pop__input');
  });

  it('the composer textarea has no ring of its own — the whole box carries the focus affordance', () => {
    // Excluded from the outline set on purpose: the textarea and the controls row are
    // one control, so focus lights up the BOX around both. The textarea's own outline
    // drew a second, hard rectangle around only the top half. The box affordance is
    // what keeps this WCAG 2.4.7-compliant, so assert it is really there.
    const rules = mount(AssistantPanelSheet);
    const rule = focusRule(rules, '.ax-composer__input');
    expect(rule, '.ax-composer__input:focus-visible rule missing').toBeTruthy();
    expect(rule!.style.getPropertyValue('outline'), '.ax-composer__input must suppress the global ring').toBe('none');

    const box = baseRule(rules, '.ax-composer__box--focus');
    expect(box, '.ax-composer__box--focus rule missing').toBeTruthy();
    expect(box!.style.getPropertyValue('border-color'), 'the focused box must show an accent border').toContain('var(--ax-accent)');
    expect(box!.style.getPropertyValue('box-shadow'), 'the focused box must show a ring').toBeTruthy();
  });

  it('kpi .condition-warning-icon (the quiet ⚠) carries the standard focus ring', () => {
    // The old .condition-warning full-text advisory (box-shadow tint) is gone with the toast-model
    // rework; the quiet always-present ⚠ icon is now the focusable warning control, so it must carry the
    // standard keyboard ring like every other focus-managed control (WCAG 2.4.7).
    const rules = mount(KpiSheet);
    expectStandardRing(rules, '.condition-warning-icon');
  });

  // One sheet per test: Angular's shared style host injects a component's styles only on the first
  // mount of a TestBed lifecycle, so mounting a second sheet inside one it() yields zero rules.
  it('tile-editor .te-modal stays ring-free with outline:none (programmatic focus)', () => {
    const te = mount(TileEditorSheet);
    expect(focusRule(te, '.te-modal'), '.te-modal must NOT gain a focus ring').toBeUndefined();
    expect(baseRule(te, '.te-modal')?.style.getPropertyValue('outline')).toBe('none');
  });

  it('confirm-dialog .cd-modal stays ring-free with outline:none (programmatic focus)', () => {
    const cd = mount(ConfirmDialogSheet);
    expect(focusRule(cd, '.cd-modal'), '.cd-modal must NOT gain a focus ring').toBeUndefined();
    expect(baseRule(cd, '.cd-modal')?.style.getPropertyValue('outline')).toBe('none');
  });
});
