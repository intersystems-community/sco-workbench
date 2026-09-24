/**
 * Types for the two scmodel payloads the Dashboard reads. `ScModelService`
 * returns `any`, so these are applied at the consumer boundary.
 *
 * Both shapes were measured live on 2026-08-14. Note that
 * `GET /api/scmodel/v1/objects/Carrier` returns exactly `objectName`,
 * `className`, `description`, `attributes` — no `isCustom` — whereas the list
 * payload from `GET /api/scmodel/v1/objects` does include `isCustom`. That is
 * why `ScObjectDetailPayload` does not extend `ScObjectSummary` by way of a
 * shared `isCustom`, and why `resources.ts`'s own private interfaces (which
 * assert `ScObjectDetail extends ScObject`, hence `isCustom` on the detail)
 * were left alone rather than unified here: correcting them is a separate
 * change to a file with no tests.
 */

/** One entry from `GET /api/scmodel/v1/objects`. */
export interface ScObjectSummary {
  objectName: string;
  className: string;
  description: string;
  /**
   * Present only on the list payload (not on the per-object detail). True for
   * user-defined objects, whose scdata path is derivable as `objectName + 's'`
   * lowercased — see `resourceForObject`.
   */
  isCustom?: boolean;
}

/** One attribute from `GET /api/scmodel/v1/objects/{objectName}`. */
export interface ScModelAttribute {
  name: string;
  description?: string;
  dataType?: string;
  required?: boolean;
}

/** The `GET /api/scmodel/v1/objects/{objectName}` payload. */
export interface ScObjectDetailPayload {
  objectName: string;
  className: string;
  description: string;
  attributes: ScModelAttribute[];
}
