import type { Env } from '../config/env.js';
import { AtelierClient } from './atelier-client.js';
import { NativeClient } from './native-client.js';
import { DeepSeeClient } from './deepsee-client.js';
import { KpiRestClient } from './kpi-rest-client.js';
import { ScbiKpiValueClient } from './kpi-value-client.js';
import { ScModelRestClient } from './scmodel-rest-client.js';
import { IssueRestClient } from './issue-rest-client.js';

/**
 * Bundle of configured IRIS clients shared by the SDK tools. Built once from
 * env. The Atelier client is stateless; the Native client holds a lazy
 * connection that is reused across calls.
 */
export interface IrisServices {
  atelier: AtelierClient;
  native: NativeClient;
  deepsee: DeepSeeClient;
  /** SCO Business KPI REST API (same endpoints the Angular workbench uses). */
  kpi: KpiRestClient;
  /** SCO Business KPI VALUES read (D3 charting). */
  kpiValues: ScbiKpiValueClient;
  /** SCO Issue data API (paged/filtered issue reads for the Issue Management page). */
  issues: IssueRestClient;
  /** SCO Data Model REST API, READ-only — the same objects/attributes the Data Model
   *  page shows, so the assistant can answer about an object from any page. */
  scmodel: ScModelRestClient;
  namespace: string;
  close(): void;
}

export function createIrisServices(env: Env): IrisServices {
  const timeoutMs = env.SCO_HTTP_TIMEOUT_MS;
  const retries = env.SCO_HTTP_RETRIES;
  const atelier = new AtelierClient({
    host: env.SCO_HOST,
    port: env.SCO_WEB_PORT,
    namespace: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
    prefix: env.SCO_WEB_PREFIX,
    timeoutMs,
    retries,
  });
  const native = new NativeClient({
    host: env.SCO_HOST,
    port: env.SCO_SUPERSERVER_PORT,
    namespace: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
  });
  // Read-only D2CLIENT REST client for cube structure (measures/dimensions/listings).
  // Uses the web port (same as Atelier); the DeepSee "application" is the namespace.
  const deepsee = new DeepSeeClient({
    host: env.SCO_HOST,
    port: env.SCO_WEB_PORT,
    app: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
    prefix: env.SCO_WEB_PREFIX,
    timeoutMs,
    retries,
  });
  // SCO Business KPI REST API — same web port + auth as Atelier; base path is
  // /api/{ns}/scbi/v1. Used by the agent-mode KPI tools to create/update KPIs
  // through the supported REST path instead of reinventing the save.
  const kpi = new KpiRestClient({
    host: env.SCO_HOST,
    port: env.SCO_WEB_PORT,
    namespace: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
    prefix: env.SCO_WEB_PREFIX,
    timeoutMs,
    retries,
  });
  // SCO Data Model REST API (read-only) — base /api/{ns}/scmodel/v1, same web port
  // and auth as the others. Lets a lookup answer "what does object X look like?" with
  // what the Data Model page itself would show, from any page.
  const scmodel = new ScModelRestClient({
    host: env.SCO_HOST,
    port: env.SCO_WEB_PORT,
    namespace: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
    prefix: env.SCO_WEB_PREFIX,
    timeoutMs,
    retries,
  });
  const kpiValues = new ScbiKpiValueClient({
    host: env.SCO_HOST,
    port: env.SCO_WEB_PORT,
    namespace: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
    prefix: env.SCO_WEB_PREFIX,
    timeoutMs,
    retries,
  });
  // SCO Issue data API — same web port + auth, base path /api/{ns}/scdata/v1.
  const issues = new IssueRestClient({
    host: env.SCO_HOST,
    port: env.SCO_WEB_PORT,
    namespace: env.SCO_NAMESPACE,
    user: env.SCO_USER,
    password: env.SCO_PASSWORD,
    prefix: env.SCO_WEB_PREFIX,
    timeoutMs,
    retries,
  });
  return {
    atelier,
    native,
    deepsee,
    kpi,
    kpiValues,
    issues,
    scmodel,
    namespace: env.SCO_NAMESPACE,
    close: () => native.close(),
  };
}

export { AtelierClient } from './atelier-client.js';
export { NativeClient } from './native-client.js';
export { DeepSeeClient } from './deepsee-client.js';
export { KpiRestClient } from './kpi-rest-client.js';
export { ScbiKpiValueClient } from './kpi-value-client.js';
export { IssueRestClient } from './issue-rest-client.js';
export { ScModelRestClient } from './scmodel-rest-client.js';
