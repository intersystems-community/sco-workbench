import { Directive, ElementRef, Input, effect, inject } from '@angular/core';
import { WorkbenchBridgeService } from './workbench-bridge.service';

/**
 * Marks an element as a Guided-mode highlight target. When the assistant calls
 * the `ui_highlight` tool with a matching id, the backend streams a directive,
 * the bridge sets `highlightTarget`, and this directive toggles a pulsing ring
 * on the element — anywhere in the app, reactively, without per-component
 * bindings.
 *
 *   <button [axGuide]="'build-button'">Build</button>
 *   <input  [axGuide]="'name'" ... />
 *   <input  [axGuide]="'measures.0.aggregate'" ... />
 *
 * The id is what the model passes as `ui_highlight`'s target, OR the `ui_set_field`
 * path — a field the assistant just filled gets a subtler "changed" flash so the
 * user can see WHAT was set. Both cues clear on the next click (clearHighlight()).
 */
@Directive({
  selector: '[axGuide]',
  standalone: true,
})
export class GuideHighlightDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly bridge = inject(WorkbenchBridgeService);

  @Input('axGuide') guideId = '';

  constructor() {
    // React to the shared highlight target: add/remove the pulsing-ring class.
    effect(() => {
      const active = this.bridge.highlightTarget();
      const on = !!this.guideId && active === this.guideId;
      this.el.nativeElement.classList.toggle('guided-highlight', on);
      if (on) {
        // Defer the scroll to a rendered frame. This app is zoneless, so the
        // effect runs before layout/paint; scrolling synchronously mis-targets
        // elements low in a just-opened scroll container (e.g. the Save/Compile/
        // Build buttons at the bottom of the cube form) — the ring gets applied
        // but the button never comes into view, reading as "highlight didn't
        // work". rAF waits until the layout is settled.
        const el = this.el.nativeElement;
        requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
    });
    // React to the just-changed field set: mark a field the assistant filled.
    effect(() => {
      const changed = this.bridge.changedFields();
      const on = !!this.guideId && changed.has(this.guideId);
      this.el.nativeElement.classList.toggle('guided-changed', on);
    });
  }
}
