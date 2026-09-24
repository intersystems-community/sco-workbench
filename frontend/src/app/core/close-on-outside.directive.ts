import { Directive, ElementRef, HostListener, inject } from '@angular/core';

/**
 * Closes a native <details> when the user clicks outside it or presses Escape. Native <details> only
 * toggles on its own <summary>; without this a member popup stays open when the user clicks the row,
 * the cube rail, or anywhere else — the collapse-on-click-away behavior every dropdown is expected to
 * have. Clicks inside the control (ticking a checkbox) are left alone so multi-select still works.
 */
@Directive({
  selector: 'details[axCloseOnOutside]',
  standalone: true,
})
export class CloseOnOutsideDirective {
  private readonly host = inject(ElementRef<HTMLDetailsElement>);

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    const el = this.host.nativeElement as HTMLDetailsElement;
    if (!el.open) return;
    if (event.target instanceof Node && el.contains(event.target)) return; // click inside — leave open
    el.open = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    const el = this.host.nativeElement as HTMLDetailsElement;
    if (el.open) el.open = false;
  }
}
