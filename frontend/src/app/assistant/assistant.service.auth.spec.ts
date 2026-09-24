import { AssistantService } from './assistant.service';
import { setApiToken } from '../core/api';

// The service sends plain-object headers, so we read them as a record and
// duck-type the response — no reliance on the Response/Headers global
// constructors being present in the jsdom test env.
describe('AssistantService attaches the bearer on raw fetch calls', () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; init?: RequestInit }>;
  let svc: AssistantService;

  beforeEach(() => {
    svc = new AssistantService();
    calls = [];
    setApiToken('tok');
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sessions: [], atelier: 'reachable', namespace: 'SC' }),
      } as unknown as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setApiToken('');
  });

  function authOf(urlEnds: string): string | undefined {
    const call = calls.find((c) => c.url.endsWith(urlEnds));
    if (!call) throw new Error(`no fetch to ${urlEnds}`);
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    return headers['Authorization'];
  }

  it('sends the bearer on POST /api/agent/chat (the SSE agent path)', () => {
    // chat() returns a cold Observable; subscribing runs the subscriber
    // synchronously, which calls fetch() (recording the call) before its first
    // await. The mock has no res.body, so the stream errors immediately — the
    // error handler swallows that; the header was already captured on the call.
    svc.chat(null, 'hi').subscribe({ error: () => {} });
    expect(authOf('/api/agent/chat')).toBe('Bearer tok');
  });

  it('sends the bearer on POST /api/agent/confirm', async () => {
    await svc.confirm('s', 'c', 'approve');
    expect(authOf('/api/agent/confirm')).toBe('Bearer tok');
  });

  it('sends the bearer on GET /api/sessions', async () => {
    await svc.listSessions();
    expect(authOf('/api/sessions')).toBe('Bearer tok');
  });

  it('does NOT send a bearer on /healthz (exempt endpoint)', async () => {
    await svc.health();
    expect(authOf('/healthz')).toBeUndefined();
  });
});
