import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AssistantPanelComponent } from './assistant-panel';
import { AssistantService } from './assistant.service';
import { WorkbenchBridgeService, type SetFieldResult, type UiDirective } from '../core/workbench-bridge.service';

/**
 * Regression: a Guided-mode UI directive MUST always be acked.
 *
 * The backend UiControlBroker BLOCKS the `ui_*` tool call until the frontend
 * POSTs an ack, then times out after 8s. The reported bug: `ui_open_form` opened
 * the form (a later `ui_navigate` snapshot proved it) yet the tool reported
 * "no ack within 8000ms" — because applyDirectiveAndAck forced an `appRef.tick()`
 * that threw a zoneless re-entrant-CD error AFTER the directive applied but BEFORE
 * uiAck ran, and the whole promise was `void`-ed so the throw was swallowed and
 * the ack lost. The fix guards the tick and sends the ack in a `finally`. These
 * pins fail if either regresses (the ack goes back to being skippable on throw).
 */
function setup(uiAck: (sessionId: string, directiveId: string, result?: SetFieldResult) => Promise<void>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AssistantPanelComponent],
    providers: [
      { provide: AssistantService, useValue: { listSessions: vi.fn(async () => []), uiAck: vi.fn(uiAck) } },
    ],
  });
  const bridge = TestBed.inject(WorkbenchBridgeService);
  const fixture = TestBed.createComponent(AssistantPanelComponent);
  fixture.detectChanges();
  const api = TestBed.inject(AssistantService) as unknown as { uiAck: ReturnType<typeof vi.fn> };
  return { fixture, bridge, api, component: fixture.componentInstance };
}

/** Invoke the private applyDirectiveAndAck the way the SSE 'ui_directive' case does. */
function applyAndAck(component: AssistantPanelComponent, d: UiDirective & { sessionId: string; directiveId: string }): Promise<void> {
  return (component as unknown as { applyDirectiveAndAck: (d: unknown) => Promise<void> }).applyDirectiveAndAck(d);
}

describe('AssistantPanelComponent — directive ack is guaranteed', () => {
  it('acks an open_form directive even when the forced appRef.tick() throws', async () => {
    const acks: Array<{ directiveId: string; result?: SetFieldResult }> = [];
    const { component, bridge, api } = setup(async (_s, directiveId, result) => { acks.push({ directiveId, result }); });

    // The directive itself applies fine (the form opens)...
    vi.spyOn(bridge, 'applyDirective').mockResolvedValue({ applied: true });
    // ...but the forced synchronous CD pass throws — the exact zoneless re-entrant
    // tick that used to swallow the ack.
    vi.spyOn(TestBed.inject(ApplicationRef), 'tick').mockImplementation(() => {
      throw new Error('NG0100: re-entrant change detection');
    });

    await applyAndAck(component, { action: 'open_form', target: 'kpi', sessionId: 's1', directiveId: 'd1' });

    // The ack still fired, and it reports the applied result (not a failure) —
    // the tick throwing is not a directive failure, the form did open.
    expect(api.uiAck).toHaveBeenCalledTimes(1);
    expect(acks).toEqual([{ directiveId: 'd1', result: { applied: true } }]);
  });

  it('acks with applied:false + detail when applying the directive itself throws', async () => {
    const acks: Array<{ directiveId: string; result?: SetFieldResult }> = [];
    const { component, bridge, api } = setup(async (_s, directiveId, result) => { acks.push({ directiveId, result }); });

    vi.spyOn(bridge, 'applyDirective').mockRejectedValue(new Error('controller never mounted'));

    await applyAndAck(component, { action: 'set_field', target: 'name', sessionId: 's1', directiveId: 'd2' });

    expect(api.uiAck).toHaveBeenCalledTimes(1);
    expect(acks[0]!.directiveId).toBe('d2');
    expect(acks[0]!.result?.applied).toBe(false);
    expect(acks[0]!.result?.detail).toContain('controller never mounted');
  });

  it('forwards a set_field applied:false result from the controller unchanged', async () => {
    const acks: Array<{ result?: SetFieldResult }> = [];
    const { component, bridge, api } = setup(async (_s, _d, result) => { acks.push({ result }); });

    vi.spyOn(bridge, 'applyDirective').mockResolvedValue({ applied: false, detail: 'not a measure' });

    await applyAndAck(component, { action: 'set_field', target: 'kpiMeasure', sessionId: 's1', directiveId: 'd3' });

    expect(api.uiAck).toHaveBeenCalledTimes(1);
    expect(acks[0]!.result).toEqual({ applied: false, detail: 'not a measure' });
  });
});
