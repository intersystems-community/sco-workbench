import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * An ambient label in the assistant composer naming the feature page the
 * assistant is currently acting on. Purely presentational: it renders the label
 * it is given and holds no state, so it is trivially testable in isolation. The
 * current-page derivation lives on WorkbenchBridgeService (activeViewLabel); the
 * composer binds it into [label]. The title attribute surfaces the full label
 * when the text ellipsizes on a narrow dock.
 *
 * Styled as MUTED FLAT TEXT — no fill, no border, no pill — deliberately. It sits
 * in the composer controls row right next to the "Guided" mode picker; when it
 * carried a tinted, bordered, accent-coloured pill, users read it as a button and
 * tried to click it. Flat muted grey reads as a status label, not a control. The
 * colour uses the composer's dim token (--ax-dim ≈ #656d76) with a #6b7785
 * fallback for standalone use; both clear WCAG AA against the composer surface.
 */
@Component({
  selector: 'app-context-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="context-badge" data-testid="context-badge" [title]="label()">{{ label() }}</span>`,
  styles: [`
    .context-badge {
      display: inline-block;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
      padding: 0;
      font-size: 11px;
      font-weight: 400;
      line-height: 1.4;
      color: var(--ax-dim, #6b7785);
      background: none;
      border: none;
    }
  `],
})
export class ContextBadgeComponent {
  /** Friendly label of the current feature page (e.g. "Analytics Cube"). */
  readonly label = input.required<string>();
}
