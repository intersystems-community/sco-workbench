import { describe, it, expect } from 'vitest';
import { emitSdkMessage, newEmitContext, type SseWriter } from '../../src/server/sse.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Capture SSE events into an array for assertions. */
function captureWriter(): { writer: SseWriter; events: Array<{ event: string; data: unknown }> } {
  const events: Array<{ event: string; data: unknown }> = [];
  const writer: SseWriter = {
    send: (event, data) => events.push({ event, data }),
    comment: () => {},
    close: () => {},
  };
  return { writer, events };
}

describe('emitSdkMessage', () => {
  it('maps a text delta stream_event to a token event', () => {
    const { writer, events } = captureWriter();
    emitSdkMessage(
      writer,
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      } as unknown as SDKMessage,
      newEmitContext(),
    );
    expect(events).toEqual([{ event: 'token', data: { text: 'Hello' } }]);
  });

  it('maps a tool_use assistant block to a tool_use event', () => {
    const { writer, events } = captureWriter();
    emitSdkMessage(
      writer,
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'sco_compile_class', input: { className: 'A.B' } }] },
      } as unknown as SDKMessage,
      newEmitContext(),
    );
    expect(events[0]).toEqual({
      event: 'tool_use',
      data: { name: 'sco_compile_class', input: { className: 'A.B' } },
    });
  });

  it('maps a tool_result user block, reading ok from the JSON payload', () => {
    const { writer, events } = captureWriter();
    emitSdkMessage(
      writer,
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: JSON.stringify({ ok: false, error: 'boom' }), is_error: false },
          ],
        },
      } as unknown as SDKMessage,
      newEmitContext(),
    );
    expect(events[0]!.event).toBe('tool_result');
    expect((events[0]!.data as { ok: boolean }).ok).toBe(false);
  });

  it('suppresses ToolSearch tool_use and its matching tool_result', () => {
    const { writer, events } = captureWriter();
    const ctx = newEmitContext();
    // ToolSearch call — should be dropped and its id remembered.
    emitSdkMessage(
      writer,
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'ts1', name: 'ToolSearch', input: { query: 'x' } }] },
      } as unknown as SDKMessage,
      ctx,
    );
    // Its result — should also be dropped.
    emitSdkMessage(
      writer,
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'ts1', content: '{}' }] },
      } as unknown as SDKMessage,
      ctx,
    );
    expect(events).toHaveLength(0);
  });

  it('maps a successful result and returns the final text', () => {
    const { writer, events } = captureWriter();
    const text = emitSdkMessage(
      writer,
      { type: 'result', subtype: 'success', result: 'All done.' } as unknown as SDKMessage,
      newEmitContext(),
    );
    expect(text).toBe('All done.');
    expect(events[0]).toEqual({ event: 'result', data: { text: 'All done.' } });
  });

  it('maps a non-success result to an error event', () => {
    const { writer, events } = captureWriter();
    const text = emitSdkMessage(
      writer,
      // A generic failure, so this still covers the fallback branch. The
      // `error_max_turns` subtype now has its own message and its own test below.
      { type: 'result', subtype: 'error_during_execution', result: '' } as unknown as SDKMessage,
      newEmitContext(),
    );
    expect(text).toBeUndefined();
    expect(events[0]!.event).toBe('error');
    expect((events[0]!.data as { message: string }).message).toMatch(/without a successful result/);
  });

  it('explains a turn stopped by the termination bound instead of showing a bare failure', () => {
    const { writer, events } = captureWriter();
    // The SDK sends this subtype with NO result text when maxTurns is hit, so the
    // generic fallback would render an unhelpful message for the one non-success
    // case we deliberately introduced (AGENT_MAX_TURNS).
    const text = emitSdkMessage(
      writer,
      { type: 'result', subtype: 'error_max_turns', result: '' } as unknown as SDKMessage,
      newEmitContext(),
    );
    expect(text).toBeUndefined();
    expect(events[0]!.event).toBe('error');
    const message = (events[0]!.data as { message: string }).message;
    expect(message).toMatch(/step limit/i);
    // It must tell the user how to proceed, and name the knob.
    expect(message).toMatch(/AGENT_MAX_TURNS/);
    expect(message).not.toMatch(/without a successful result/);
  });

  it('persists the final text only ONCE — the trailing streamed text is not duplicated by result', () => {
    const { writer } = captureWriter();
    const ctx = newEmitContext();
    // Stream the final answer as token deltas...
    emitSdkMessage(
      writer,
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The answer is 42.' } } } as unknown as SDKMessage,
      ctx,
    );
    // ...then the success result carrying the same text.
    emitSdkMessage(
      writer,
      { type: 'result', subtype: 'success', result: 'The answer is 42.' } as unknown as SDKMessage,
      ctx,
    );
    // The persisted timeline must have exactly one entry (the result), not a
    // duplicate text + result pair (which caused doubled messages on replay).
    expect(ctx.events).toEqual([{ t: 'result', text: 'The answer is 42.' }]);
    expect(ctx.textBuffer).toBe('');
  });

  it('keeps streamed prose in the timeline when a turn ends without a success result', () => {
    const { writer } = captureWriter();
    const ctx = newEmitContext();
    emitSdkMessage(
      writer,
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial thought…' } } } as unknown as SDKMessage,
      ctx,
    );
    emitSdkMessage(
      writer,
      { type: 'result', subtype: 'error_max_turns', result: '' } as unknown as SDKMessage,
      ctx,
    );
    expect(ctx.events).toEqual([{ t: 'text', text: 'Partial thought…' }]);
  });
});
