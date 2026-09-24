/**
 * The two guards that make the setup gate a BLOCK rather than a suggestion.
 *
 * `scoReadyGuard` sits on the Workbench route: with an unconfirmed instance it
 * redirects to /setup, so there is no URL that reaches the Workbench while a
 * prerequisite is unmet — not a hand-typed one, not a bookmark, not a deep link.
 *
 * `setupOnlyWhenBlockedGuard` sits on /setup and does the reverse, so a healthy
 * install cannot get stuck looking at a troubleshooting page.
 *
 * Both read the verdict the bootstrap initializer already produced (see
 * core/preflight.ts); neither performs I/O, so navigation stays synchronous.
 */
import type { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { scoReady } from '../core/preflight';

/** Allow the Workbench only when SCO was confirmed; otherwise show the gate. */
export const scoReadyGuard: CanActivateFn = () => {
  if (scoReady()) return true;
  return inject(Router).createUrlTree(['/setup']);
};

/** Keep /setup for the blocked case only. */
export const setupOnlyWhenBlockedGuard: CanActivateFn = () => {
  if (!scoReady()) return true;
  return inject(Router).createUrlTree(['/workbench']);
};
