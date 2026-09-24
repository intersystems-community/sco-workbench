import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ContextBadgeComponent } from './context-badge';

describe('ContextBadgeComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  function mount(label: string): { fixture: ComponentFixture<ContextBadgeComponent>; el: HTMLElement } {
    TestBed.configureTestingModule({ imports: [ContextBadgeComponent] });
    const fixture = TestBed.createComponent(ContextBadgeComponent);
    fixture.componentRef.setInput('label', label);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('renders the label text and mirrors it into the title attribute', () => {
    const { el } = mount('Analytics Cube');
    const badge = el.querySelector('[data-testid="context-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent?.trim()).toBe('Analytics Cube');
    expect(badge.getAttribute('title')).toBe('Analytics Cube');
  });

  it('updates the rendered text when the label input changes', () => {
    const { fixture, el } = mount('Analytics Cube');
    fixture.componentRef.setInput('label', 'Business KPI');
    fixture.detectChanges();
    const badge = el.querySelector('[data-testid="context-badge"]') as HTMLElement;
    expect(badge.textContent?.trim()).toBe('Business KPI');
    expect(badge.getAttribute('title')).toBe('Business KPI');
  });
});
