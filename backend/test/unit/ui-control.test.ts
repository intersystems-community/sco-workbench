import { describe, it, expect, vi, afterEach } from 'vitest';
import { UiControlBroker } from '../../src/server/ui-control.js';

/**
 * SC-2662 (C16) defect 1 — the fix.
 *
 * UiControlBroker.send() waits ACK_TIMEOUT_MS (8000ms) for the frontend ack. A
 * lost/absent ack, or a client disconnect (ackAll), now resolves an explicit
 * applied:false — so ui_set_field maps it to fail(...) and the agent learns the
 * UI never confirmed, instead of the old empty-result silent success. The type
 * makes applied REQUIRED, so no future resolve path can reintroduce the hole.
 */
describe('UiControlBroker ack timeout (SC-2662 defect 1, fixed)', () => {
  afterEach(() => vi.useRealTimers());

  it('control: an ack that arrives before the timeout resolves send() with the real ack result', async () => {
    let sentId = '';
    const broker = new UiControlBroker((req) => { sentId = req.directiveId; });
    const p = broker.send({ action: 'set_field', target: 'name', value: 'x' });
    expect(broker.ack(sentId, { applied: true })).toBe(true);
    await expect(p).resolves.toEqual({ applied: true });
  });

  it('on ack timeout, send() resolves applied:false — a lost ack is a visible failure (SC-2662 defect 1 fixed)', async () => {
    vi.useFakeTimers();
    const broker = new UiControlBroker(() => { /* frontend never acks */ });
    const p = broker.send({ action: 'set_field', target: 'name', value: 'x' });
    // Advance past ACK_TIMEOUT_MS (8000ms) with no ack; flush the resolve microtask.
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).resolves.toEqual({ applied: false, detail: 'no ack within 8000ms' });
  });

  it('ackAll() resolves every pending send() as applied:false (client disconnect is a visible failure)', async () => {
    let sentId = '';
    const broker = new UiControlBroker((req) => { sentId = req.directiveId; });
    const p = broker.send({ action: 'set_field', target: 'name', value: 'x' });
    expect(sentId).not.toBe('');
    broker.ackAll();
    await expect(p).resolves.toEqual({ applied: false, detail: 'client disconnected before ack' });
  });
});
