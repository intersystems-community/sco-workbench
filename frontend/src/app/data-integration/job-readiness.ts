/**
 * Is a pipeline complete enough to deploy?
 *
 * Deploy hands a pipeline to the agent, which generates and compiles IRIS classes
 * from it. A half-configured pipeline therefore fails DEEP inside that turn — as a
 * compile error or a service pointing at nothing — where the user can neither see
 * which field they skipped nor fix it. So the same rules the wizard enforces per
 * step are re-applied to the SAVED job before Deploy starts, and drive the "Ready"
 * badge in the list.
 *
 * Everything here is a pure function of a saved `IntegrationJob`, deliberately with
 * no component/HTTP dependency, because:
 *   • Deploy is pressed from the DETAIL page, where the wizard's live state (which
 *     schema is selected, which class's properties are loaded) does not exist;
 *   • every job in the list is judged for its badge, not just the open one.
 * The wizard's own per-step getters delegate to the same functions so the gate that
 * blocks Save and the gate that blocks Deploy can never disagree.
 */

import type { IntegrationJob, SourceColumn, SourceConfig, SourceType } from './data-integration.model';

/** Which wizard step the user has to go back to, plus what to fix there. */
export interface ReadinessGap {
  step: 1 | 2 | 3;
  /** Step title as shown in the wizard's step bar, for the warning's heading. */
  stepLabel: string;
  /** One ready-to-show sentence naming what is missing. */
  message: string;
}

const STEP_LABELS: Record<1 | 2 | 3, string> = {
  1: 'Data Source',
  2: 'Data Entity',
  3: 'Mapping',
};

/**
 * EVERY required Step-1 field still empty, by its on-screen label (exactly the fields
 * carrying a `*`), in the order they appear on the form. Empty = Step 1 is complete.
 *
 * The whole list, not just the first, because two callers need it: the form's error
 * banner names one field at a time, but the assistant's UI context has to report the
 * full remaining set — given only the first, it announced "Step 1 is now complete"
 * while a required Data Source Name was still blank.
 *
 * Takes the raw name + config rather than a job so the live wizard form can be checked
 * with it too (the wizard's `missingStep1Fields` getter is this function).
 */
export function missingStep1Fields(name: string, sourceType: SourceType, c: SourceConfig): string[] {
  // [label, filled] in on-screen order. Listing them (rather than early-returning)
  // is what lets both callers share one definition of "required".
  const checks: [string, boolean][] = [['Integration Name', !!name.trim()]];
  switch (sourceType) {
    case 'database':
      checks.push(
        ['Data Source Name', !!c.dbDataSourceName?.trim()],
        ['Database Type', !!c.dbType?.trim()],
        ['DSN (JDBC URL)', !!c.dbDsn?.trim()],
        ['Username', !!c.dbUsername?.trim()],
        // Not trimmed: a password of spaces is legal, an empty one is not.
        ['Password', !!c.dbPassword],
      );
      break;
    case 'ftp':
      checks.push(
        ['Data Source Name', !!c.ftpDataSourceName?.trim()],
        ['Host', !!c.ftpHost?.trim()],
        ['Username', !!c.ftpUsername?.trim()],
      );
      // SFTP authenticates with the uploaded key pair, so both files are required
      // there. Plain FTP has no equivalent — an anonymous, password-less login is valid.
      if (c.ftpSftp) {
        checks.push(
          ['SFTP Public Key File', !!c.sftpPublicKeyFile?.trim()],
          ['SFTP Private Key File', !!c.sftpPrivateKeyFile?.trim()],
        );
      }
      break;
    case 'cloud':
      checks.push(
        ['Bucket Name', !!c.cloudBucket?.trim()],
        ['Storage Region', !!c.cloudRegion?.trim()],
        ['AWS-S3 Credentials File', !!c.cloudCredentialsFile?.trim()],
      );
      break;
    case 'file':
      checks.push(['File', !!c.filePath?.trim()]);
      break;
    default:
      // rest-api is not selectable (DISABLED_SOURCE_TYPES); never block on it.
      return [];
  }
  return checks.filter(([, filled]) => !filled).map(([label]) => label);
}

/** The FIRST required Step-1 field still empty, or null when Step 1 is complete —
 *  what the form's error banner names. */
export function missingStep1Field(name: string, sourceType: SourceType, c: SourceConfig): string | null {
  return missingStep1Fields(name, sourceType, c)[0] ?? null;
}

/**
 * True when the config names the entity the deployed pipeline will actually poll —
 * the SELECT derived from schema.table, the FTP FileSpec, the S3 blob pattern, the
 * local file's directory. This is what Step 2 produces, and it is stored on the
 * config rather than only in `dataEntity` (a display summary), so it is also what
 * the generated adapter reads.
 */
export function hasPolledEntity(sourceType: SourceType, c: SourceConfig): boolean {
  switch (sourceType) {
    case 'database': return !!c.dbQuery?.trim();      // derived from schema.table
    case 'ftp':      return !!c.ftpFileSpec?.trim();  // the polled filename
    case 'cloud':    return !!c.cloudBlobPattern?.trim();
    case 'file':     return !!c.filePath?.trim();
    default:         return false;
  }
}

/** The target properties mapped by at least one source column (trimmed, non-empty). */
export function mappedTargetProperties(columns: readonly SourceColumn[]): Set<string> {
  return new Set(
    columns.map((c) => c.targetProperty?.trim()).filter((t): t is string => !!t),
  );
}

/** Required target properties that no source column maps to. Empty when the mapping
 *  is complete (or nothing is required). */
export function unmappedRequiredProperties(
  requiredNames: readonly string[],
  columns: readonly SourceColumn[],
): string[] {
  const mapped = mappedTargetProperties(columns);
  return requiredNames.filter((name) => !mapped.has(name));
}

/**
 * Every reason `job` cannot be deployed yet, in wizard order — empty means ready.
 *
 * Reported as a LIST rather than the first failure: a pipeline abandoned halfway is
 * usually incomplete on more than one step, and sending the user back one step at a
 * time (deploy → fix → deploy → fix) hides how much is left.
 */
export function jobReadinessGaps(job: IntegrationJob): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  const gap = (step: 1 | 2 | 3, message: string) => gaps.push({ step, stepLabel: STEP_LABELS[step], message });

  // ── Step 1: the connection/source fields marked required ──
  const missingField = missingStep1Field(job.name ?? '', job.sourceType, job.source);
  if (missingField) gap(1, `${missingField} is required.`);

  // ── Step 2: a data entity was picked, and it yielded columns ──
  // Both halves matter: the polled entity is what the adapter reads, and the columns
  // are what Step 3 maps. A job with one and not the other deploys a pipeline that
  // either points at nothing or transforms nothing.
  //
  // The Local File adapter is the exception: its entity is the file uploaded in STEP
  // 1, and Step 2 only previews it. So a missing file there is reported once, against
  // the step that actually has the control for it, and Step 2 is judged solely on
  // whether that file yielded columns — sending the user to a step with nothing to
  // pick on it would be a dead end.
  const entityBelongsToStep1 = job.sourceType === 'file';
  if (!entityBelongsToStep1 && (!hasPolledEntity(job.sourceType, job.source) || !job.dataEntity)) {
    gap(2, 'Select the data entity to load from (a table, file, or object).');
  } else if (!job.columns.length) {
    gap(2, 'The selected data entity has no source columns to map.');
  }

  // ── Step 3: a target class, and a complete mapping onto it ──
  if (!job.targetClass?.trim()) {
    gap(3, 'Select a target class.');
  } else {
    const mapped = mappedTargetProperties(job.columns);
    if (!mapped.size) {
      gap(3, 'Map at least one source field to a target property.');
    } else {
      // Cases saved before `requiredTargetProperties` existed carry no list, so
      // there is nothing to check — Save already enforced the same rule when they
      // were written, so they are not held back for a field we simply can't see.
      const unmapped = unmappedRequiredProperties(job.requiredTargetProperties ?? [], job.columns);
      if (unmapped.length) {
        gap(3, `Map every required target property. Unmapped: ${unmapped.join(', ')}.`);
      }
    }
  }

  return gaps;
}

/** True when every wizard step is complete, so Deploy can run. */
export function isJobReady(job: IntegrationJob): boolean {
  return jobReadinessGaps(job).length === 0;
}

/** The gaps as the warning dialog's body: one "Step N (Name): what to fix" per line. */
export function readinessWarningMessage(gaps: readonly ReadinessGap[]): string {
  return gaps.map((g) => `Step ${g.step} · ${g.stepLabel}: ${g.message}`).join('\n');
}
