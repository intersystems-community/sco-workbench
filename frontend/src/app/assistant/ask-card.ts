import { Component, ElementRef, EventEmitter, Input, Output, OnInit, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { AskRequest, AskAnswer } from './models';

/**
 * Tabbed ask_user_question card — one tab per question, rendered inline in the
 * assistant panel. Ported from the standalone chat UI's floating question modal,
 * preserving its exact interaction model:
 *   - NO auto-advance on selection (an option may be "I'll type them in"); the
 *     user advances with the arrow or Enter, so they can select AND type.
 *   - selection and free-text combine — both are sent back to the agent.
 *   - Enter advances / submits on the last; Cmd/Ctrl+Enter submits from anywhere.
 *   - Esc cancels, which stops the turn.
 */
@Component({
  selector: 'app-ask-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="ax-modal ax-ask" role="dialog" aria-modal="false"
         [class.ax-ask--collapsed]="collapsed"
         [style.transform]="'translate(' + dragX + 'px, ' + dragY + 'px)'">
      <div class="ax-modal__head ax-ask__head ax-ask__head--drag"
           [class.ax-ask__head--dragging]="dragging"
           (mousedown)="onDragStart($event)"
           title="Drag to move">
        <span class="ax-modal__title">Question</span>
        <div class="ax-ask__head-actions">
          <!-- Collapsed, the card keeps a count so a pending question can't be
               forgotten about — the agent is blocked until it's answered. -->
          <span class="ax-ask__head-count" *ngIf="collapsed && req.questions.length > 1">
            {{ answeredCount }}/{{ req.questions.length }}
          </span>
          <button class="ax-ask__icon-btn" type="button"
                  [title]="collapsed ? 'Expand' : 'Collapse'"
                  [attr.aria-label]="collapsed ? 'Expand question' : 'Collapse question'"
                  [attr.aria-expanded]="!collapsed"
                  (click)="toggleCollapsed()"
                  (mousedown)="$event.stopPropagation()">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path [attr.d]="collapsed ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'"/>
            </svg>
          </button>
          <button class="ax-ask__icon-btn ax-ask__close" type="button" title="Cancel (Esc)" aria-label="Cancel" (click)="cancel()" (mousedown)="$event.stopPropagation()">✕</button>
        </div>
      </div>

      <!-- Tab strip (only when >1 question) -->
      <div class="ax-ask__tabs" *ngIf="!collapsed && req.questions.length > 1">
        <button
          *ngFor="let q of req.questions; let i = index"
          type="button"
          class="ax-tab"
          [class.active]="i === active"
          [class.answered]="isAnswered(i)"
          [title]="q.question"
          (click)="active = i"
        >
          <span class="ax-tab__check" *ngIf="isAnswered(i) && i !== active">✓</span>{{ q.header }}
        </button>
      </div>

      <div class="ax-ask__body" *ngIf="!collapsed">
        <p class="ax-ask__question">{{ current.question }}</p>
        <div class="ax-options">
          <button
            *ngFor="let opt of current.options"
            type="button"
            class="ax-option"
            [class.selected]="isSelected(opt.label)"
            (click)="toggle(opt.label)"
          >
            <span class="ax-option__mark">{{ mark(opt.label) }}</span>
            <span class="ax-option__text">
              <span class="ax-option__label">{{ opt.label }}</span>
              <span class="ax-option__desc" *ngIf="opt.description">{{ opt.description }}</span>
            </span>
          </button>
        </div>
        <div class="ax-other">
          <label class="ax-other__label">Or type your own answer</label>
          <input
            class="ax-other__input"
            type="text"
            placeholder="Type a custom answer…"
            [(ngModel)]="answers[active].other"
          />
        </div>
      </div>

      <div class="ax-modal__actions ax-ask__actions" *ngIf="!collapsed">
        <div class="ax-ask__meta">
          <span class="ax-ask__hint">Esc to cancel — this stops the current task.</span>
          <span class="ax-ask__progress" *ngIf="req.questions.length > 1">
            {{ answeredCount }} of {{ req.questions.length }} answered
          </span>
        </div>
        <button
          *ngIf="!isLast"
          class="ax-ask__next"
          type="button"
          title="Next question"
          [disabled]="!isAnswered(active)"
          (click)="goNext()"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        </button>
        <button
          *ngIf="isLast"
          class="ax-ask__submit"
          type="button"
          title="Submit"
          [disabled]="!allAnswered"
          (click)="submit()"
        >
          Submit
        </button>
      </div>
    </div>
  `,
  styleUrl: './assistant-modals.css',
})
export class AskCardComponent implements OnInit {
  @Input({ required: true }) req!: AskRequest;
  /** Emits the assembled answers keyed by question header. */
  @Output() answered = new EventEmitter<Record<string, AskAnswer>>();
  /** Emits when the user dismisses the card (cancel). */
  @Output() cancelled = new EventEmitter<void>();

  active = 0;
  answers: AskAnswer[] = [];
  private done = false;

  /**
   * Collapsed to just its header bar, so the card can be tucked away to read the
   * chat underneath without losing what's been answered — the answers live in
   * `answers`, not in the DOM, so collapsing and re-expanding keeps them.
   */
  collapsed = false;

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
  }

  // ── Drag (move the card by its header so it doesn't cover the chat) ──
  /** Current offset from the card's default (right-aligned) resting position. */
  dragX = 0;
  dragY = 0;
  dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginX = 0;
  private dragOriginY = 0;
  private readonly host = inject(ElementRef<HTMLElement>);

  ngOnInit(): void {
    this.answers = this.req.questions.map(() => ({ selected: [], other: '' }));
  }

  /** Start dragging from the header (ignored if the press began on the close button). */
  onDragStart(e: MouseEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragOriginX = this.dragX;
    this.dragOriginY = this.dragY;
  }

  @HostListener('document:mousemove', ['$event'])
  onDragMove(e: MouseEvent): void {
    if (!this.dragging) return;
    // Proposed new offset from the pointer delta.
    let nx = this.dragOriginX + (e.clientX - this.dragStartX);
    let ny = this.dragOriginY + (e.clientY - this.dragStartY);
    // Clamp so the card stays within the chat panel (its offset parent).
    // Clamp within the whole assistant panel so the card can travel the full
    // height (up over the transcript, down toward the composer) — not just the
    // small overlay strip it rests in. Bound to `.ax-panel`; fall back to the
    // offset parent if it isn't found.
    const el = this.host.nativeElement.firstElementChild as HTMLElement | null;
    const bound =
      (this.host.nativeElement.closest('.ax-panel') as HTMLElement | null) ??
      (this.host.nativeElement.offsetParent as HTMLElement | null);
    if (el && bound) {
      const card = el.getBoundingClientRect();
      const box = bound.getBoundingClientRect();
      const MARGIN = 8;
      // Bounds are expressed as offset deltas from the card's CURRENT position
      // (which already includes dragX/dragY), so add them back in.
      const minX = box.left + MARGIN - card.left + this.dragX;
      const maxX = box.right - MARGIN - card.right + this.dragX;
      const minY = box.top + MARGIN - card.top + this.dragY;
      const maxY = box.bottom - MARGIN - card.bottom + this.dragY;
      // Guard: if the card is taller/wider than the box, keep min ≤ max.
      nx = Math.min(Math.max(maxX, minX), Math.max(minX, nx));
      ny = Math.min(Math.max(maxY, minY), Math.max(minY, ny));
    }
    this.dragX = nx;
    this.dragY = ny;
  }

  @HostListener('document:mouseup')
  onDragEnd(): void {
    this.dragging = false;
  }

  get current() {
    return this.req.questions[this.active]!;
  }
  get isLast(): boolean {
    return this.active === this.req.questions.length - 1;
  }
  get allAnswered(): boolean {
    return this.req.questions.every((_, i) => this.isAnswered(i));
  }
  get answeredCount(): number {
    return this.req.questions.filter((_, i) => this.isAnswered(i)).length;
  }

  isAnswered(i: number): boolean {
    const a = this.answers[i];
    return !!a && (a.selected.length > 0 || Boolean(a.other && a.other.trim()));
  }

  isSelected(label: string): boolean {
    return this.answers[this.active]!.selected.includes(label);
  }

  mark(label: string): string {
    const sel = this.isSelected(label);
    return this.current.multiSelect ? (sel ? '☑' : '☐') : sel ? '●' : '○';
  }

  toggle(label: string): void {
    // Selecting does NOT clear typed text or auto-advance — an option like
    // "I'll type them in" pairs with the free-text box, and the user advances
    // explicitly with the arrow / Enter.
    const a = this.answers[this.active]!;
    if (this.current.multiSelect) {
      const at = a.selected.indexOf(label);
      if (at === -1) a.selected.push(label);
      else a.selected.splice(at, 1);
    } else {
      a.selected = a.selected[0] === label ? [] : [label];
    }
  }

  goNext(): void {
    if (this.isLast) {
      this.submit();
    } else if (this.isAnswered(this.active)) {
      this.active += 1;
    }
  }

  submit(): void {
    if (this.done || !this.allAnswered) return;
    this.done = true;
    const payload: Record<string, AskAnswer> = {};
    this.req.questions.forEach((q, i) => {
      const a = this.answers[i]!;
      const other = a.other?.trim();
      payload[q.header] = { selected: a.selected, ...(other ? { other } : {}) };
    });
    this.answered.emit(payload);
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.cancelled.emit();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (this.done) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Collapsed, the options aren't on screen — Enter opens the card rather than
      // advancing or submitting an answer the user can't currently see.
      if (this.collapsed) {
        this.collapsed = false;
        return;
      }
      if (e.metaKey || e.ctrlKey) this.submit();
      else this.goNext();
    }
  }
}
