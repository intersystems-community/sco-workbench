// backend/src/dashboard/cube-shape.ts
import type { DeepSeeClient } from '../iris/deepsee-client.js';
import type { AtelierClient } from '../iris/atelier-client.js';
import { cubeStructure, readCubeDefinitionForDisplay } from '../iris/cube-catalog-ops.js';
import type { CubeShape, CubeShapeReader, DimensionKind } from './chart-data.js';

/**
 * CubeShapeReader over the existing cubeStructure — ZERO new IRIS traffic beyond
 * what bi-cubes already trusts. Maps the DeepSee dimension type to the charting
 * axis nature: time/age → temporal; everything else, INCLUDING an absent tag
 * (no class definition parsed), → categorical. Never guesses temporal — the
 * failure this exists to prevent is drawing a line where bars belong.
 */
export class DeepSeeShapeAdapter implements CubeShapeReader {
  constructor(
    private readonly deepsee: DeepSeeClient,
    private readonly atelier: AtelierClient,
  ) {}

  async shape(cube: string): Promise<CubeShape> {
    // Prefer the parsed class definition so time/age dims are tagged (read-only,
    // works for SCO built-ins too); degrade to null → all dims categorical.
    const definition = await readCubeDefinitionForDisplay(this.atelier, cube).catch(() => null);
    const s = await cubeStructure(this.deepsee, cube, definition);
    return {
      cube,
      measures: s.measures.map((m) => ({ name: m.name, caption: m.caption })),
      // B-CUBE-15: carry EVERY level (name, caption, spec) the catalog reconstructed —
      // hierarchies.flatMap(h => h.levels), in catalog order — instead of collapsing to
      // the first hierarchy's first level. The cube query enumerates the CHOSEN level's
      // `${spec}.MEMBERS` (never dimension-wide [dim].MEMBERS, the D2 [All]-leak). ZERO new
      // IRIS traffic: cubeStructure already fetched these levels; we stop dropping them.
      dimensions: s.dimensions.map((d) => ({
        name: d.name,
        kind: toKind(d.type),
        levels: (d.hierarchies ?? []).flatMap((h) => h.levels).map((l) => ({
          name: l.name,
          ...(l.caption ? { caption: l.caption } : {}),
          spec: l.spec,
        })),
      })),
    };
  }
}

function toKind(type: string | undefined): DimensionKind {
  return type === 'time' || type === 'age' ? 'temporal' : 'categorical';
}
