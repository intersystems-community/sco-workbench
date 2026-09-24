import { Routes } from '@angular/router';
import { WorkbenchComponent } from './workbench/workbench';
import { SetupGateComponent } from './startup/setup-gate';
import { scoReadyGuard, setupOnlyWhenBlockedGuard } from './startup/setup.guard';

/**
 * No user auth: the workbench is the default (and only) page. It IS gated on the
 * startup preflight though — `scoReadyGuard` redirects to /setup unless SCO was
 * confirmed up, authenticating and new enough, including for the `**` fallback, so
 * no URL slips past the gate.
 */
export const routes: Routes = [
  { path: '', redirectTo: 'workbench', pathMatch: 'full' },
  { path: 'workbench', component: WorkbenchComponent, canActivate: [scoReadyGuard] },
  { path: 'setup', component: SetupGateComponent, canActivate: [setupOnlyWhenBlockedGuard] },
  { path: '**', redirectTo: 'workbench' },
];
