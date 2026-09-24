import { TestBed } from '@angular/core/testing';
import { AssistantPanelComponent } from './assistant-panel';
import { AssistantService } from './assistant.service';
import { WorkbenchBridgeService, type FeatureKey } from '../core/workbench-bridge.service';

/**
 * The composer's animated placeholder is page-specific: the task typed after
 * "Ask the assistant to " comes from the list for the current feature page, and
 * navigating to another page restarts the typewriter on that page's list.
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
  return { fixture, bridge };
}

/** Advance the typewriter (45ms per character) just far enough to finish `task`. */
function typeOutTask(task: string): void {
  vi.advanceTimersByTime(45 * (task.length + 2));
}

describe('AssistantPanelComponent placeholder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const KPI_TASK = 'help me create a KPI step by step…';
  const INTEGRATION_TASK = 'help me fill out this integration form…';

  it('types a task from the current page list', () => {
    const { fixture, bridge } = setup();
    bridge.activeView.set('kpi');
    fixture.detectChanges();
    typeOutTask(KPI_TASK);
    expect(fixture.componentInstance.placeholder()).toBe(`Ask the assistant to ${KPI_TASK}`);
  });

  it('restarts on the new page list when the user navigates', () => {
    const { fixture, bridge } = setup();
    bridge.activeView.set('kpi');
    fixture.detectChanges();
    typeOutTask(KPI_TASK);
    bridge.activeView.set('data-integration');
    fixture.detectChanges();
    typeOutTask(INTEGRATION_TASK);
    expect(fixture.componentInstance.placeholder()).toBe(
      `Ask the assistant to ${INTEGRATION_TASK}`,
    );
  });

  it('has a non-empty task list for every page in both modes', () => {
    const { fixture } = setup();
    const tasks = (fixture.componentInstance as unknown as {
      placeholderTasks: Record<string, Record<FeatureKey, string[]>>;
    }).placeholderTasks;
    for (const mode of ['agent', 'guided']) {
      for (const list of Object.values(tasks[mode]!)) {
        expect(list.length).toBeGreaterThan(0);
      }
    }
  });
});
