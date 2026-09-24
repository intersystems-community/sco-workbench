import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Helpers to build MCP tool results. Every tool returns a compact JSON payload
 * as text so the model can relay it, plus `isError` on failure so the SDK
 * surfaces it correctly.
 */

export function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }],
  };
}

export function fail(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message, ...extra }) }],
    isError: true,
  };
}

/** Wrap a handler so thrown errors become a clean tool error result. */
export async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
