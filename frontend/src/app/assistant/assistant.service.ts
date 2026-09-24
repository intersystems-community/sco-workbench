import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { SseEvent, SessionSummary, HealthStatus, AskAnswer } from './models';
import { apiUrl, authHeaders } from '../core/api';

/**
 * Talks to the SCO Workbench agent backend. Calls go through `apiUrl()`, which
 * defaults to same-origin relative paths (`/api/...`, `/healthz`) — flowing
 * through the Angular dev proxy → our Node backend, which owns the agent runtime
 * and reverse-proxies IRIS. Setting `environment.apiBaseUrl` retargets them at a
 * separately-deployed backend without touching these call sites.
 */
@Injectable({ providedIn: 'root' })
export class AssistantService {
  /**
   * Stream an agent turn as Server-Sent Events over a POST. Returns a cold
   * Observable of decoded {event, data} frames; subscribing starts the request,
   * unsubscribing aborts it (which stops the backend turn — the Stop button).
   */
  chat(
    sessionId: string | null,
    message: string,
    opts?: { mode?: 'agent' | 'guided'; uiContext?: string; displayText?: string },
  ): Observable<SseEvent> {
    return new Observable<SseEvent>((subscriber) => {
      const controller = new AbortController();

      (async () => {
        try {
          const res = await fetch(apiUrl('/api/agent/chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
              sessionId,
              message,
              mode: opts?.mode ?? 'agent',
              uiContext: opts?.uiContext ?? '',
              displayText: opts?.displayText ?? '',
            }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            subscriber.error(new Error(`Request failed (HTTP ${res.status}).`));
            return;
          }
          for await (const ev of parseSse(res)) {
            subscriber.next(ev);
          }
          subscriber.complete();
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            subscriber.complete(); // aborted by unsubscribe (Stop) — a clean end
          } else {
            subscriber.error(err);
          }
        }
      })();

      return () => controller.abort();
    });
  }

  /** Resolve a state-changing tool's approval gate. */
  async confirm(sessionId: string, confirmId: string, decision: 'approve' | 'reject'): Promise<void> {
    await fetch(apiUrl('/api/agent/confirm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, confirmId, decision }),
    });
  }

  /** Answer an ask_user_question prompt with the tabbed-popup selections. */
  async answer(sessionId: string, askId: string, answers: Record<string, AskAnswer>): Promise<void> {
    await fetch(apiUrl('/api/agent/answer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, askId, answers }),
    });
  }

  /**
   * Acknowledge a Guided-mode UI directive was applied, unblocking the agent.
   * `applied`/`detail` report whether a set_field value actually landed, so the
   * backend tool can tell the model the truth (a dropdown value that matched no
   * option was NOT applied).
   */
  async uiAck(
    sessionId: string,
    directiveId: string,
    result?: { applied?: boolean; detail?: string },
  ): Promise<void> {
    await fetch(apiUrl('/api/agent/ui-ack'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, directiveId, ...result }),
    });
  }

  /** Cancel an open ask_user_question — dismissing it stops the whole turn. */
  async cancelAnswer(sessionId: string, askId: string): Promise<void> {
    await fetch(apiUrl('/api/agent/answer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, askId, cancel: true }),
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const res = await fetch(apiUrl('/api/sessions'), { headers: authHeaders() });
    if (!res.ok) return [];
    const { sessions } = await res.json();
    return Array.isArray(sessions) ? sessions : [];
  }

  async loadSession(
    id: string,
  ): Promise<Array<{ role: string; content: string; displayText?: string | null; toolCalls?: unknown }>> {
    const res = await fetch(apiUrl(`/api/sessions/${id}`), { headers: authHeaders() });
    if (!res.ok) return [];
    const { messages } = await res.json();
    return Array.isArray(messages) ? messages : [];
  }

  /** Delete a chat session (and its messages) on the backend. Returns whether it
   *  succeeded so the caller can toast on failure. */
  async deleteSession(id: string): Promise<boolean> {
    const res = await fetch(apiUrl(`/api/sessions/${id}`), {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return res.ok;
  }

  async health(): Promise<HealthStatus> {
    try {
      const res = await fetch(apiUrl('/healthz'));
      const h = await res.json();
      return {
        ok: res.ok && h.atelier !== 'unreachable',
        namespace: h.namespace,
        atelier: h.atelier,
      };
    } catch {
      return { ok: false };
    }
  }
}

/** Decode an SSE stream (event:/data: frames separated by blank lines). */
async function* parseSse(res: Response): AsyncGenerator<SseEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        try {
          yield { event, data: JSON.parse(data) };
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}
