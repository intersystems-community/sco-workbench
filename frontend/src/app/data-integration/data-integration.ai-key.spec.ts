import { of, throwError } from 'rxjs';
import { DataIntegrationComponent } from './data-integration';
import { setAiEnabled, AI_KEY_MISSING_SHORT } from '../core/ai-status';

/** The backend's invalid-credentials message (the wording itself lives in backend
 *  ai-errors.ts; this page only has to pass whatever arrives through to the toast). */
const REJECTED = 'Invalid credentials provided for Claude. Please use the correct credentials and restart the server to use the AI features.';

/**
 * The two AI-backed controls on this page when Claude is unavailable.
 *
 * Deploy hands the work to the agent, so with no key there is nothing to hand it
 * to. The button STAYS enabled and opens a modal that explains itself — a greyed
 * control teaches nobody why the feature vanished.
 *
 * Auto-map has a local name-match fallback, which used to make a missing/rejected
 * key INVISIBLE: the grid filled in either way. Every degraded outcome now reports
 * itself in a toast and still applies the local mapping.
 *
 * Same style as data-integration.spec.ts: the component class is driven directly,
 * because what's under test is its decision logic, not the wizard's rendering.
 */
function makeComponent(autoMapResult: unknown = of({ ok: true, mappings: [] })) {
  const autoMapFields = vi.fn(() => autoMapResult as never);
  const runAgentPrompt = vi.fn();
  const toastError = vi.fn();
  const noop = () => undefined;
  // The deploy-pending set lives on the bridge (it outlives this component), and
  // the single-deploy lock reads it on every Deploy — so the stub has to behave
  // like the real signal, not just exist.
  let pending: ReadonlySet<string> = new Set();
  const bridge = {
    register: noop,
    unregister: noop,
    runAgentPrompt,
    pendingDeploys: () => pending,
    markDeployPending: (id: string) => { pending = new Set(pending).add(id); },
    clearDeployPending: (id: string) => { const next = new Set(pending); next.delete(id); pending = next; },
  };
  // Cases persistence (SQLite). Deploy upserts the pipeline's IRIS credential
  // BEFORE handing off to the agent, so this has to emit for the positive-control
  // deploys to reach runAgentPrompt at all; setStatus is the deployed-phase write.
  const casesApi = {
    createCredentialFromCase: vi.fn(() => of({ ok: true, name: null as string | null })),
    setStatus: vi.fn((id: string, status: string) => of({ ok: true, id, status })),
  };
  const component = new DataIntegrationComponent(
    { getClasses: () => of([]) } as never,                          // ScModelService
    { autoMapFields } as never,                                     // DataSourceService
    {} as never,                                                    // UploadService
    casesApi as never,                                              // DataIntegrationService
    {} as never,                                                    // SqlConnectionTestService
    {} as never,                                                    // FtpConnectionTestService
    {} as never,                                                    // SftpConnectionTestService
    {} as never,                                                    // CloudConnectionTestService
    { markForCheck: noop, detectChanges: noop } as never,            // ChangeDetectorRef
    bridge as never,                                                 // WorkbenchBridgeService
    { show: noop, error: toastError, success: noop, info: noop } as never, // ToastService
  );
  return { component, autoMapFields, runAgentPrompt, toastError };
}

/** A mapping grid with one obvious name match, so the local fallback has work to do. */
function withMappingGrid(component: DataIntegrationComponent): void {
  component.sourceColumns = [
    { name: 'sku', type: 'String' },
    { name: 'nothing_alike', type: 'String' },
  ];
  component.targetProperties = [
    { name: 'SKU', dataType: '%String', required: false },
    { name: 'Region', dataType: '%String', required: false },
  ];
  component.selectedTargetClass = 'User.Product';
}

/**
 * A saved pipeline that is COMPLETE — every wizard step filled in, so it passes the
 * readiness gate. What's under test here is the Claude-key gate, so the pipeline
 * itself must be deployable; an unfinished one would be refused for the wrong reason
 * (see the readiness suite in data-integration.spec.ts for that gate).
 */
function job() {
  return {
    id: 'job-1',
    name: 'Nightly load',
    status: 'draft',
    sourceType: 'file',
    sourceName: 'orders.csv',
    source: { type: 'file', adapterType: 'File', filePath: '/uploads', fileSpec: 'orders.csv' },
    dataEntity: { nameLabel: 'File', name: 'orders.csv', sourceLabel: 'Path', source: '/uploads' },
    targetClass: 'User.Product',
    hasHeader: true,
    columns: [{ name: 'sku', type: 'String', targetProperty: 'SKU' }],
    requiredTargetProperties: ['SKU'],
  } as never;
}

describe('Deploy with no Claude key', () => {
  afterEach(() => setAiEnabled(true));

  it('opens the explanatory modal instead of starting a deploy', () => {
    setAiEnabled(false);
    const { component, runAgentPrompt } = makeComponent();

    component.deployIntegration(job());

    expect(component.showAiKeyDialog).toBe(true);
    expect(runAgentPrompt).not.toHaveBeenCalled();
    // No pending state either: a pipeline stuck on "Deploying…" forever would be
    // the worse failure, and it also blocks every later deploy (single-deploy lock).
    expect(component.isPending('job-1')).toBe(false);
    expect(component.anyDeployPending()).toBe(false);
  });

  it('the modal text says what to configure and that the rest still works', () => {
    setAiEnabled(false);
    const { component } = makeComponent();
    expect(component.aiKeyMissingMessage).toMatch(/^Claude key not provided\./);
    expect(component.aiKeyMissingMessage).toContain('AWS_BEARER_TOKEN_BEDROCK');
    expect(component.aiKeyMissingMessage).toMatch(/keeps working/i);
  });

  it('the dialog is not open until Deploy is pressed', () => {
    setAiEnabled(false);
    const { component } = makeComponent();
    expect(component.showAiKeyDialog).toBe(false);
  });

  it('hands off to the agent normally when a key IS configured', () => {
    // Positive control: the guard must not swallow a deploy that can run.
    const { component, runAgentPrompt } = makeComponent();

    component.deployIntegration(job());

    expect(component.showAiKeyDialog).toBe(false);
    expect(component.isPending('job-1')).toBe(true);
    expect(runAgentPrompt).toHaveBeenCalled();
  });

  it('a refused deploy leaves no residue: the next one runs', () => {
    // The refusal must not half-start anything. Dismiss the modal, configure a key,
    // press Deploy again — it goes through, which also proves the single-deploy
    // lock wasn't left held by the deploy that never happened.
    setAiEnabled(false);
    const { component, runAgentPrompt } = makeComponent();
    component.deployIntegration(job());
    component.showAiKeyDialog = false; // OK / backdrop

    setAiEnabled(true);
    component.deployIntegration(job());

    expect(component.showAiKeyDialog).toBe(false);
    expect(runAgentPrompt).toHaveBeenCalledTimes(1);
    expect(component.isPending('job-1')).toBe(true);
  });
});

describe('Auto-map when the AI is unavailable', () => {
  afterEach(() => setAiEnabled(true));

  it('reports the missing key, maps locally, and never calls the backend', () => {
    setAiEnabled(false);
    const { component, autoMapFields, toastError } = makeComponent();
    withMappingGrid(component);

    component.autoMap();

    expect(autoMapFields).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    const message = toastError.mock.calls[0]![0] as string;
    expect(message).toContain(AI_KEY_MISSING_SHORT);
    expect(message).toMatch(/local name match/i);
    // Still better than an empty grid — the obvious pair is filled in, the rest isn't.
    expect(component.sourceColumns[0]!.targetProperty).toBe('SKU');
    expect(component.sourceColumns[1]!.targetProperty).toBe('');
    expect(component.autoMapping).toBe(false);
  });

  it('passes through the backend\'s invalid-credentials verdict', () => {
    // A rejected key can't be known up front, so it comes back as ok:false with the
    // reason. The toast must say WHICH problem it was, not a generic failure.
    const { component, toastError } = makeComponent(of({ ok: false, message: REJECTED }));
    withMappingGrid(component);

    component.autoMap();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0] as string).toContain('Invalid credentials provided for Claude');
    expect(component.sourceColumns[0]!.targetProperty).toBe('SKU');
    expect(component.autoMapping).toBe(false);
  });

  it('reports an ok:false with no message rather than staying silent', () => {
    const { component, toastError } = makeComponent(of({ ok: false }));
    withMappingGrid(component);

    component.autoMap();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0] as string).toMatch(/could not suggest a mapping/i);
  });

  it('reports a failed request and clears the spinner', () => {
    // HTTP-level failure (backend down, 500, token rejected by the API gate).
    const { component, toastError } = makeComponent(
      throwError(() => ({ error: { error: 'agent turn failed' } })),
    );
    withMappingGrid(component);

    component.autoMap();

    expect(toastError.mock.calls[0]![0] as string).toContain('agent turn failed');
    expect(component.autoMapping).toBe(false);
    expect(component.sourceColumns[0]!.targetProperty).toBe('SKU');
  });

  it('falls back with a generic reason when the error carries no detail', () => {
    const { component, toastError } = makeComponent(throwError(() => new Error('Network error')));
    withMappingGrid(component);

    component.autoMap();

    expect(toastError.mock.calls[0]![0] as string).toMatch(/could not reach the AI service/i);
  });

  it('says nothing when the AI mapping succeeds', () => {
    // Positive control: the toast is a DEGRADATION notice, so a real AI mapping must
    // not produce one — otherwise it becomes noise nobody reads.
    const { component, toastError } = makeComponent(
      of({ ok: true, mappings: [{ sourceField: 'nothing_alike', targetProperty: 'Region', confidence: 0.9, reason: 'semantic' }] }),
    );
    withMappingGrid(component);

    component.autoMap();

    expect(toastError).not.toHaveBeenCalled();
    // The AI's answer is used as given, not merged with the local guess.
    expect(component.sourceColumns[0]!.targetProperty).toBe('');
    expect(component.sourceColumns[1]!.targetProperty).toBe('Region');
  });
});
