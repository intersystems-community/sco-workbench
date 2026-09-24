import type { Response } from 'express';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Server-Sent Events helpers and a mapper from the Agent SDK's SDKMessage
 * stream to the compact event shape our chat UI consumes:
 *   token   { text }            — incremental assistant text
 *   tool_use{ name, input }     — the agent invoked an IRIS tool
 *   tool_result { name, ok, text } — a tool returned
 *   result  { text }            — final assistant answer for the turn
 *   error   { message }         — a turn-level error
 * (confirm_request is emitted separately by the ConfirmationBroker; ask_request
 *  by the QuestionBroker; and `ui_directive` { action, target, value } by the
 *  UiControlBroker — the Guided-mode channel that drives the Angular UI.)
 */

export interface SseWriter {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
}

export function openSse(res: Response): SseWriter {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Prime the stream so proxies flush headers.
  res.write(': connected\n\n');
  return {
    send(event, data) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      res.write(`: ${text}\n\n`);
    },
    close() {
      res.end();
    },
  };
}

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

/** Extract a plain-text summary from a tool_result content block. */
function toolResultText(block: ContentBlock): { ok: boolean; text: string } {
  const raw = block.content;
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    text = raw
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('');
  }
  // Our tools return JSON { ok, ... }; try to read ok from it.
  let ok = !block.is_error;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.ok === 'boolean') ok = parsed.ok;
  } catch {
    // not JSON; keep is_error-derived ok
  }
  return { ok, text };
}

/**
 * A persisted timeline event for one assistant turn. Replayed by the frontend
 * to reconstruct the full turn (prose + tool steps + summary) after a refresh.
 */
export type TurnEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; name: string; input: unknown; ok?: boolean; output?: string; id?: string }
  | { t: 'result'; text: string };

/** Per-turn state carried across emitSdkMessage calls. */
export interface EmitContext {
  /** tool_use_ids whose call+result are suppressed from the UI (e.g. ToolSearch). */
  suppressed: Set<string>;
  /** Ordered timeline events for persistence (coalesced text + resolved tools). */
  events: TurnEvent[];
  /** Running buffer of streamed text tokens (flushed to a `text` event). */
  textBuffer: string;
}

export function newEmitContext(): EmitContext {
  return { suppressed: new Set(), events: [], textBuffer: '' };
}

/** Flush any buffered streamed text into a single `text` event. */
function flushText(ctx: EmitContext): void {
  if (ctx.textBuffer.trim()) ctx.events.push({ t: 'text', text: ctx.textBuffer });
  ctx.textBuffer = '';
}

/**
 * Tools whose call+result are noise in the timeline and should not be shown.
 * `ToolSearch` is internal SDK plumbing; `ask_user_question` drives its own
 * tabbed popup (the confirm/ask UI), so echoing the tool call+result into the
 * timeline would be redundant. Matched by suffix since MCP tools are exposed
 * under a qualified name (e.g. `mcp__sco__ask_user_question`).
 */
const HIDDEN_TOOL_SUFFIXES = ['ToolSearch', 'ask_user_question'];

function isHiddenTool(name: string | undefined): boolean {
  if (!name) return false;
  return HIDDEN_TOOL_SUFFIXES.some((s) => name === s || name.endsWith(`__${s}`));
}

/**
 * Map a single SDKMessage to zero or more SSE events, writing them to `sse` and
 * recording a coalesced timeline into `ctx.events` for persistence. Returns the
 * assistant's final text when a result message is seen, else undefined.
 */
export function emitSdkMessage(sse: SseWriter, message: SDKMessage, ctx: EmitContext): string | undefined {
  switch (message.type) {
    case 'stream_event': {
      // Partial streaming deltas (includePartialMessages).
      const ev = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        sse.send('token', { text: ev.delta.text });
        ctx.textBuffer += ev.delta.text;
      }
      return undefined;
    }
    case 'assistant': {
      const blocks = (message.message?.content ?? []) as ContentBlock[];
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          // Suppress internal/noise tools (ToolSearch, ask_user_question): drop
          // the call and remember its id so the matching tool_result is dropped too.
          if (isHiddenTool(b.name)) {
            if (b.id) ctx.suppressed.add(b.id);
            continue;
          }
          flushText(ctx);
          ctx.events.push({ t: 'tool', name: b.name ?? '', input: b.input, id: b.id });
          sse.send('tool_use', { name: b.name, input: b.input });
        }
      }
      return undefined;
    }
    case 'user': {
      // tool_result blocks come back as a synthetic user message.
      const blocks = (message.message?.content ?? []) as ContentBlock[];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          if (b.tool_use_id && ctx.suppressed.has(b.tool_use_id)) continue;
          const { ok, text } = toolResultText(b);
          // Fill the matching pending tool event with its result.
          const pending = [...ctx.events].reverse().find(
            (e): e is Extract<TurnEvent, { t: 'tool' }> =>
              e.t === 'tool' && e.ok === undefined && (!b.tool_use_id || e.id === b.tool_use_id),
          );
          if (pending) {
            pending.ok = ok;
            pending.output = text;
          }
          sse.send('tool_result', { ok, text });
        }
      }
      return undefined;
    }
    case 'result': {
      const text = 'result' in message && typeof message.result === 'string' ? message.result : '';
      const subtype = (message as { subtype?: string }).subtype;
      if (subtype === 'success') {
        // The buffered streamed text after the last tool IS the final result
        // text — persisting BOTH a trailing `text` event and the `result` event
        // duplicates the message on replay. So: if we have a result, drop the
        // trailing buffer (it's the same content) and persist only `result`;
        // otherwise flush whatever streamed text we have.
        if (text.trim()) {
          ctx.textBuffer = '';
          ctx.events.push({ t: 'result', text });
        } else {
          flushText(ctx);
        }
        sse.send('result', { text });
        return text;
      }
      // On a non-success result, keep any streamed prose we already have.
      flushText(ctx);
      // A turn stopped by the termination bound (AGENT_MAX_TURNS) reports this
      // subtype and carries NO result text, so say what happened instead of showing
      // the bare fallback. The work already done still stands — the persisted
      // timeline holds the tool steps — so tell the user how to continue.
      if (subtype === 'error_max_turns') {
        sse.send('error', {
          message:
            'The agent reached its step limit for a single message and stopped. Anything it already did is above. Send another message to continue, or raise AGENT_MAX_TURNS if this flow legitimately needs more steps.',
        });
        return undefined;
      }
      sse.send('error', { message: text || 'The agent ended without a successful result.' });
      return undefined;
    }
    default:
      return undefined;
  }
}
