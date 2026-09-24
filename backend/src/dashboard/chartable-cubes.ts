// backend/src/dashboard/chartable-cubes.ts
import type { AtelierClient } from '../iris/atelier-client.js';
import { listCubes } from '../iris/cube-catalog-ops.js';
import type {
  ChartableCube,
  CubeCatalog,
  CubeCatalogEntry,
  CubeShapeReader,
} from './chart-data.js';

/**
 * CubeCatalog over the existing SQL cube listing (cube-catalog-ops.listCubes) —
 * the ONE cheap dictionary query. It carries no measure/dimension counts; the
 * finder resolves those per cube. Kept behind the CubeCatalog port so the finder
 * is unit-testable with a plain fake and reusable by D3.
 */
export class AtelierCubeCatalog implements CubeCatalog {
  constructor(private readonly atelier: AtelierClient) {}
  listCubes(): Promise<CubeCatalogEntry[]> {
    return listCubes(this.atelier);
  }
}

/**
 * Lists EVERY cube in the catalog with its measure and dimension counts,
 * including 0-count residue cubes (e.g., SCO's WorkbenchTest*IT* test fixtures).
 * The frontend decides chartability from the counts (≥1 measure AND ≥1 dimension)
 * and disables non-chartable ones in the picker (Change 1). This split — backend
 * reports facts, frontend decides policy — lets the picker show counts (user
 * transparency) and adapts if future policy changes.
 *
 * A cube whose shape read FAILS (crash-level, not an ordinary IRIS-unreachable
 * read) is excluded: ordinary reads degrade gracefully (see cube-catalog-ops.ts
 * listCubes and the `.catch(() => [])` pattern for each `/Info/*` API call), so
 * a shape() rejection indicates a genuine unreadable cube, not a transient error.
 *
 * COST: the cube catalog is ONE cheap SQL query, but it carries no measure/
 * dimension counts — those come from the per-cube shape read (the D2CLIENT Info
 * API, one HTTP call each). There is no bulk measure-count path in the verified
 * IRIS contract, so this fans the shape reads out concurrently (~one round-trip
 * of wall-clock for the whole namespace, measured ~0.7s for 33 cubes) rather
 * than serially. It runs once on panel load.
 */
export class ChartableCubeFinder {
  constructor(
    private readonly catalog: CubeCatalog,
    private readonly shapeReader: CubeShapeReader,
  ) {}

  async list(): Promise<ChartableCube[]> {
    const entries = await this.catalog.listCubes();
    const resolved = await Promise.all(
      entries.map(async (entry): Promise<ChartableCube | null> => {
        try {
          const shape = await this.shapeReader.shape(entry.cubeName);
          return { ...entry, measureCount: shape.measures.length, dimensionCount: shape.dimensions.length };
        } catch {
          return null; // a genuine shape-read REJECTION (crash-level) → exclude, never crash the list
        }
      }),
    );
    return resolved.filter((c): c is ChartableCube => c !== null);
  }
}
