/**
 * The troubleshooting copy behind the setup gate, as data.
 *
 * Separated from the component because this text IS the feature: a user blocked at
 * startup has no other way in, so "could not connect to SCO" would leave them
 * guessing between a stopped container, a typo'd password, a wrong namespace and an
 * unsupported build — four different fixes. Each reason therefore gets its own
 * title, explanation and ordered steps.
 *
 * Kept as data (not markup) so the wording is reviewable in one place and testable:
 * a spec asserts every reason the backend can return has guidance here, so a new
 * backend reason cannot ship with an empty screen.
 */
import type { PreflightReason, PreflightResult } from '../core/preflight';

export interface SetupGuidance {
  /** Which prerequisite failed, as a short badge: the user's orientation. */
  prerequisite: 'Connection' | 'Authentication' | 'Version' | 'Workbench server';
  title: string;
  /** One or two sentences: what we observed and what it means. */
  explanation: string;
  /** Ordered, concrete things to try. Each should be checkable in under a minute. */
  steps: string[];
}

/**
 * Guidance for a verdict. Interpolates the ACTUAL configured values (endpoint,
 * namespace, user, versions) so a step reads "check SCO_USER, currently
 * 'superuser'" rather than a generic instruction the user must translate.
 *
 * `detail` is rendered separately by the component, so steps here never repeat it.
 */
export function guidanceFor(result: PreflightResult): SetupGuidance {
  const at = result.endpoint ? ` at ${result.endpoint}` : '';
  switch (result.reason) {
    case 'unreachable':
      return {
        prerequisite: 'Connection',
        title: 'No SCO instance answered',
        explanation:
          `Nothing is listening${at}. The instance is most likely stopped, still starting, ` +
          'or the Workbench is pointed at the wrong host or port.',
        steps: [
          'Confirm the SCO instance is running (for a container: `docker ps`, and check its status is Up).',
          `Check SCO_HOST and SCO_WEB_PORT in the Workbench .env match where SCO serves its web port${at ? ` (currently ${result.endpoint.replace(/\/api\/.*$/, '')})` : ''}.`,
          'From the Workbench host, open the SCO management portal in a browser to prove the port is reachable — a firewall or an unpublished container port blocks it otherwise.',
          'If SCO has only just started, give it a few seconds and press Retry: it accepts connections before it finishes loading.',
        ],
      };
    case 'timeout':
      return {
        prerequisite: 'Connection',
        title: 'SCO did not respond in time',
        explanation:
          `The connection${at} was accepted but no response arrived before the timeout. ` +
          'That usually means the instance is still starting up or is heavily loaded.',
        steps: [
          'Wait a few seconds and press Retry — a starting instance accepts sockets before it can serve requests.',
          'Check the instance is not saturated (its own logs, or CPU on its host).',
          'Check nothing between the Workbench and SCO is holding the request (a proxy or VPN adds its own delays).',
        ],
      };
    case 'unauthenticated':
      return {
        prerequisite: 'Authentication',
        title: 'SCO rejected the credentials',
        explanation:
          `SCO is running and reachable${at}, but it refused the configured user` +
          `${result.user ? ` "${result.user}"` : ''}. The password is wrong, the account is ` +
          'disabled or expired, or it lacks the privilege this check needs.',
        steps: [
          `Check SCO_USER and SCO_PASSWORD in the Workbench .env${result.user ? ` (the user is currently "${result.user}")` : ''}.`,
          'Confirm the account is enabled and its password has not expired — a new SCO account is often created with "change password on next login" set, which fails every API call until cleared.',
          'Confirm the account holds the SC_Data_API:READ privilege (via its roles). This endpoint requires it, so a valid password with no privilege still fails here.',
          'Try the same credentials in the SCO management portal to tell a bad password apart from a missing privilege.',
        ],
      };
    case 'api-not-found':
      return {
        prerequisite: 'Connection',
        title: 'The SCO data API is not at that address',
        explanation:
          `SCO answered${at} but reported nothing there. Either the namespace is wrong, or ` +
          'this instance does not have the SCO data API installed.',
        steps: [
          `Check SCO_NAMESPACE in the Workbench .env${result.namespace ? ` (currently "${result.namespace}")` : ''} — it must be the namespace SCO is installed into.`,
          'Confirm SCO itself is installed on this instance, not just the platform it runs on.',
          'If SCO is served under a URL prefix, set SCO_WEB_PREFIX in the Workbench .env to match.',
        ],
      };
    case 'version-too-old':
      return {
        prerequisite: 'Version',
        title: 'This SCO version is too old for the Workbench',
        explanation:
          `SCO is running and the credentials work, but it reports version ` +
          `${result.version ?? 'an older release'}, and the Workbench needs ` +
          `${result.minimumVersion} or newer. Older builds are missing endpoints the ` +
          'Workbench depends on, so it blocks here rather than failing one feature at a time.',
        steps: [
          `Upgrade the SCO instance to ${result.minimumVersion} or newer.`,
          'If you meant to point at a different instance, correct SCO_HOST / SCO_WEB_PORT / SCO_NAMESPACE in the Workbench .env and retry.',
          `Check you are running the Workbench build you intended: the ${result.minimumVersion} requirement is fixed in the build, so an older Workbench may pair with this instance.`,
        ],
      };
    case 'version-unreadable':
      return {
        prerequisite: 'Version',
        title: 'SCO reported a version the Workbench could not read',
        explanation:
          `The version endpoint${at} answered successfully, but not with a version number. ` +
          'Something is most likely answering in SCO\'s place — a proxy, a login page, or an error page.',
        steps: [
          'Open the endpoint above directly and check what it returns; it should be a bare version such as 1.7.3.',
          'If a reverse proxy or gateway sits in front of SCO, check it is not intercepting this path (an HTML login or error page is the usual culprit).',
          'Confirm SCO_WEB_PREFIX in the Workbench .env matches how SCO is served.',
        ],
      };
    case 'http-error':
      return {
        prerequisite: 'Connection',
        title: 'SCO returned an unexpected error',
        explanation:
          `The version endpoint${at} answered, but with an error rather than a version. ` +
          'The instance is reachable, so this is a problem inside SCO or in front of it.',
        steps: [
          'Check the SCO instance log for an error at the time of this request.',
          'Open the endpoint above directly to see the full response.',
          'If a reverse proxy sits in front of SCO, check whether it produced the error rather than SCO.',
        ],
      };
    case 'preflight-failed':
    default:
      return {
        prerequisite: 'Workbench server',
        title: 'The Workbench could not run its setup check',
        explanation:
          'This check runs on the Workbench server, and it could not be reached or did not ' +
          'answer usefully. The problem is with the Workbench itself, not with SCO.',
        steps: [
          'Confirm the Workbench server process is running, and check its console output for a startup error.',
          'Reload the page — if the server was restarting, the check will now succeed.',
          'If the frontend is deployed separately from the backend, check API_BASE_URL is the backend\'s address and that CORS allows this origin.',
        ],
      };
  }
}

/** Every reason the gate can show, for the exhaustiveness test. */
export const ALL_PREFLIGHT_REASONS: readonly PreflightReason[] = [
  'unreachable',
  'timeout',
  'unauthenticated',
  'api-not-found',
  'version-too-old',
  'version-unreadable',
  'http-error',
  'preflight-failed',
];
