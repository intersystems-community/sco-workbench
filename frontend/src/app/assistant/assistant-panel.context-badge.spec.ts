import { TestBed } from '@angular/core/testing';
import { AssistantPanelComponent } from './assistant-panel';
import { AssistantService } from './assistant.service';
import { WorkbenchBridgeService } from '../core/workbench-bridge.service';

/**
 * The assistant's page-context badge lives in the composer controls row (to the
 * left of the mode picker), not the dock header — moved there so it reads as an
 * ambient status label rather than a clickable control. It stays bound to the
 * bridge's activeViewLabel, so it tracks the current feature page reactively.
 */
function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AssistantPanelComponent],
    providers: [{ provide: AssistantService, useValue: { listSessions: vi.fn(async () => []) } }],
  });
  const bridge = TestBed.inject(WorkbenchBridgeService);
  const fixture = TestBed.createComponent(AssistantPanelComponent);
  fixture.detectChanges();
  return { fixture, bridge, el: fixture.nativeElement as HTMLElement };
}

describe('AssistantPanelComponent context badge', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the current feature label inside the composer controls row', () => {
    const { fixture, bridge, el } = setup();
    bridge.activeView.set('data-model');
    fixture.detectChanges();

    const controls = el.querySelector('.ax-composer__controls');
    expect(controls).not.toBeNull();
    const badge = controls!.querySelector('[data-testid="context-badge"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.textContent?.trim()).toBe('Data Model');
    expect(badge!.getAttribute('title')).toBe('Data Model');
  });

  it('updates the badge label when the user navigates to another page', () => {
    const { fixture, bridge, el } = setup();
    bridge.activeView.set('data-model');
    fixture.detectChanges();
    bridge.activeView.set('kpi');
    fixture.detectChanges();

    const badge = el.querySelector('[data-testid="context-badge"]') as HTMLElement | null;
    expect(badge!.textContent?.trim()).toBe('Business KPI');
  });
});
