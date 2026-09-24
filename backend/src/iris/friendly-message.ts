/**
 * Map a typed `IrisError` to a single user-facing sentence. Raw diagnostics
 * stay in `error.details`; this is the text the UI shows in a toast or inline
 * banner. Keep these plain, actionable, and free of internal jargon.
 */
import type { IrisError } from './iris-error.js';

const FRIENDLY: Record<string, string> = {
  SCO_UNREACHABLE: 'Could not reach SCO. Check that the instance is running and reachable.',
  SCO_TIMEOUT: 'SCO took too long to respond. Try again, or check the instance load.',
  SCO_AUTH: 'SCO rejected the connection credentials. Check the server configuration.',
  SCO_HTTP: 'SCO returned an unexpected error. See details for the server response.',
  SCO_PROTOCOL: 'SCO returned a response the Workbench could not understand.',
  COMPILE_FAILED: 'The class failed to compile in SCO. See the compiler output for details.',
  VALIDATION: 'The request was invalid. See details for what needs fixing.',
  NOT_FOUND: 'The requested item was not found in SCO.',
  CONFLICT: 'That name is already in use. Choose a different name.',
  READ_ONLY: 'This item is an SCO built-in and cannot be modified in the Workbench.',
};

/**
 * A friendly sentence for the error's code. Falls back to the error's own
 * message when the code is unknown, so nothing ever renders blank.
 */
export function friendlyMessage(err: IrisError): string {
  return FRIENDLY[err.code] ?? err.message;
}
