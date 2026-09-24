import { ChangeDetectionStrategy, ChangeDetectorRef, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { preflightResult, runPreflight, type PreflightResult } from '../core/preflight';
import { guidanceFor, type SetupGuidance } from './setup-guidance';

/**
 * The blocking setup screen. Shown INSTEAD of the Workbench whenever the startup
 * preflight could not confirm all three prerequisites: SCO is up, the configured
 * credentials authenticate, and the version is supported.
 *
 * It blocks rather than warns on purpose. Every page of the Workbench reads from
 * SCO, so letting the user in would trade one clear explanation for a dozen failing
 * panels whose real cause is off-screen. The three prerequisites are listed with
 * their state so the user can see which one failed and that the earlier ones passed
 * — a version problem implicitly confirms the connection and credentials are fine,
 * which narrows the search on its own.
 *
 * Retry re-runs the real check (no reload needed) so the loop for "start the
 * container, press Retry" is short.
 */
@Component({
  selector: 'app-setup-gate',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './setup-gate.html',
  styleUrl: './setup-gate.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupGateComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);

  result: PreflightResult = preflightResult();
  guidance: SetupGuidance = guidanceFor(this.result);
  retrying = false;

  /**
   * The three prerequisites in the order they are established, each with whether
   * this verdict proves it. A failure at step N means steps before it PASSED — the
   * probe cannot report a version without having connected and authenticated — so
   * showing them as passed is accurate and does the first half of the diagnosis.
   */
  get checks(): { label: string; state: 'pass' | 'fail' | 'unknown'; note: string }[] {
    const r = this.result;
    // Anything SCO could only have told us AFTER accepting the connection proves it
    // was reachable — a 401, a 404 and a version all require a completed exchange.
    const connected =
      r.ok || ['unauthenticated', 'api-not-found', 'version-too-old', 'version-unreadable', 'http-error'].includes(r.reason ?? '');
    // Likewise, a version reply proves the credentials were accepted: the endpoint
    // requires SC_Data_API:READ, so it could not have answered otherwise.
    const authed = r.ok || ['version-too-old', 'version-unreadable'].includes(r.reason ?? '');
    // 'unknown' is the honest state for the rest: a 404 (or a dead socket) tells us
    // nothing either way about the credentials, and claiming otherwise would send
    // the user to the wrong place.
    const authState: 'pass' | 'fail' | 'unknown' =
      authed ? 'pass' : r.reason === 'unauthenticated' ? 'fail' : 'unknown';
    return [
      {
        label: 'SCO instance is running',
        state: connected ? 'pass' : 'fail',
        note: connected ? 'Reachable' : 'No response',
      },
      {
        label: 'Credentials are accepted',
        state: authState,
        note: authState === 'pass' ? 'Authenticated' : authState === 'fail' ? 'Rejected' : 'Not established',
      },
      {
        label: `SCO version is ${r.minimumVersion || 'supported'} or newer`,
        state: r.ok ? 'pass' : r.reason === 'version-too-old' || r.reason === 'version-unreadable' ? 'fail' : 'unknown',
        note: r.ok ? `Reported ${r.version}` : r.version ? `Reported ${r.version}` : 'Not established',
      },
    ];
  }

  /**
   * Re-run the check. On success, navigate into the Workbench — the user fixed the
   * problem and should not have to find their own way in.
   */
  async retry(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    this.cdr.markForCheck();
    try {
      const next = await runPreflight();
      this.result = next;
      this.guidance = guidanceFor(next);
      if (next.ok) {
        await this.router.navigate(['/workbench']);
        return;
      }
    } finally {
      this.retrying = false;
      this.cdr.markForCheck();
    }
  }
}
