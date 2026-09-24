// backend/src/dashboard/kpi-health.ts
import type { KpiRestClient } from '../iris/kpi-rest-client.js';
import type { KpiValueClient } from '../iris/kpi-value-client.js';
import { classifyKpiValue } from '../iris/kpi-value-client.js';
import type { IssuesReader } from './kpi-issues.js';
import { deriveBands, statusOf } from './kpi-values.js';
import { BAND_COLORS } from './chart-plan.js';
import { humanizeLabel } from './humanize-label.js';
import { NotFoundError } from '../iris/iris-error.js';

/**
 * The KPI health envelope — one read model for both surfaces (detail view now, dashboard
 * tile in Phase 2). The FE renders resolved values (hex colors, status enum) and NEVER
 * re-derives thresholds. `threshold` is derived from the DEFINITION, so it is present even
 * when the value read fails (B-8). See docs/superpowers/specs/2026-08-27-b-richer-kpis-design.md §3.
 */
export interface KpiHealth {
  name: string;
  label: string;
  value: number | null;          // scalar value, Number()-coerced; null = legitimately empty
  valueUnavailable?: boolean;    // true = the value READ failed (any non-ok classifier kind)
  threshold: {
    target: number;
    bands: { to: number | null; kind: 'ok' | 'watching' | 'warning'; color: string }[];
    status: 'ok' | 'watching' | 'warning' | null;
    statusColor: string | null;
  } | null;
  issues:
    | { baseObject: string; total: number; bySeverity: { severity: number; count: number }[] }
    | { baseObject: string; unavailable: true }
    | null;
}

/**
 * Composes a KPI's definition, value, and issues into one health envelope. Reads the
 * definition ONCE (B-12) via the raw KpiRestClient — NOT through KpiValueReader (which reads
 * the def a second time and has the opposite, throw-on-error policy). Depends only on ports.
 */
export class KpiHealthReader {
  constructor(
    private readonly defs: Pick<KpiRestClient, 'get'>,
    private readonly values: KpiValueClient,
    private readonly issues: IssuesReader,
  ) {}

  async health(name: string): Promise<KpiHealth> {
    // 1. Definition — read once. Missing KPI is the ONLY thing that fails the whole read.
    const def = await this.defs.get(name);
    if (!def) throw new NotFoundError(`KPI '${name}' was not found.`);
    const label = def.label || humanizeLabel(name);

    // 2. Threshold from the DEFINITION (no value needed → survives a value failure).
    const derived = deriveBands(def.watchingThreshold, def.warningThreshold);

    // 3. Values + issues are INDEPENDENT once def is known (issues is scoped by the KPI's name, not
    //    the values read), so run them concurrently instead of serially — the zoom-in latency win.
    //    Each keeps its own degrade policy; the envelope is byte-identical.
    //    `baseObject` still rides along on the envelope: it is what the tile labels the issues with
    //    and what the drilldown scopes on, but it is NOT what the counts are filtered by (SC-2721).
    const baseObject = def.issueKpi ? def.baseObject : undefined;
    const issuesTask: Promise<KpiHealth['issues']> = baseObject
      ? this.issues.summarize(name)
          .then((s) => ({ baseObject, total: s.total, bySeverity: s.bySeverity }))
          .catch(() => ({ baseObject, unavailable: true as const }))
      : Promise.resolve<KpiHealth['issues']>(null);
    const [{ status, body }, issues] = await Promise.all([this.values.values(name), issuesTask]);

    // 4. Value with the DEGRADE policy (B-8): any non-ok classifier kind → null + unavailable.
    const cls = classifyKpiValue(status, body);
    let value: number | null = null;
    let valueUnavailable: boolean | undefined;
    if (cls.kind === 'ok') {
      const raw = body.values?.[0]?.value;
      value = raw == null ? null : Number(raw); // coerce; null STAYS null (review #3)
    } else {
      valueUnavailable = true;
    }

    // 5. Fill threshold bands + status (status is null when value null/unavailable).
    let threshold: KpiHealth['threshold'] = null;
    if (derived) {
      const bands = derived.bands.map((b) => ({
        to: Number.isFinite(b.to) ? b.to : null, // Infinity → null on the wire
        kind: b.kind,
        color: BAND_COLORS[b.kind],
      }));
      const bandStatus = statusOf(value, bands);
      threshold = { target: derived.target, bands, status: bandStatus, statusColor: bandStatus ? BAND_COLORS[bandStatus] : null };
    }

    return { name, label, value, valueUnavailable, threshold, issues };
  }
}
