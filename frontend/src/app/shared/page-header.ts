import { Component, ViewEncapsulation, input } from '@angular/core';

@Component({
  selector: 'app-page-header',
  standalone: true,
  encapsulation: ViewEncapsulation.Emulated,
  styleUrl: './page-header.css',
  template: `
    <header class="ph">
      @if (eyebrow()) { <div class="ph__eyebrow">{{ eyebrow() }}</div> }
      @if (level() === 2) { <h2 class="ph__title">{{ heading() }}</h2> }
      @else { <h1 class="ph__title">{{ heading() }}</h1> }
      <ng-content />
    </header>
  `,
})
export class PageHeaderComponent {
  readonly eyebrow = input<string>('');
  readonly heading = input.required<string>();
  readonly level = input<1 | 2>(1);
}
