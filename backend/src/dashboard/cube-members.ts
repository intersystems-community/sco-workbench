// backend/src/dashboard/cube-members.ts
import type { DeepSeeClient } from '../iris/deepsee-client.js';
import type { CubeMember, CubeMemberReader, CubeShapeReader } from './chart-data.js';
import { NotFoundError, QueryError } from '../iris/iris-error.js';

function candidates(name: string, pool: string[]): string[] {
  const lc = name.toLowerCase();
  return pool.filter((p) => p.toLowerCase().includes(lc) || lc.includes(p.toLowerCase())).slice(0, 5);
}

/**
 * Reads a dimension's member VALUES via a single MEMBERS MDX over the existing mdxExecute.
 * Enumerates the CHOSEN level's spec (`[dim].[hier].[level].MEMBERS`) — the same additivity-safe
 * set the query uses (one level: excludes [All], mixes no hierarchy levels) — resolved from the
 * shape (B-CUBE-15): an explicit `level` validated to be one of the dimension's levels[].spec,
 * else the FIRST level, else `[dim].MEMBERS` (degraded shape with no levels). Injection-closed:
 * the cube and level spec are shape-validated identifiers. Lazy by design — the shape carries
 * level specs, not enumerated members; this pays one read only when a filter needs them.
 */
export class DeepSeeMemberReader implements CubeMemberReader {
  constructor(
    private readonly shapeReader: CubeShapeReader,
    private readonly deepsee: Pick<DeepSeeClient, 'mdxExecute'>,
  ) {}

  async members(cube: string, dimension: string, level?: string): Promise<CubeMember[]> {
    const shape = await this.shapeReader.shape(cube);
    const dim = shape.dimensions.find((d) => d.name === dimension);
    if (!dim) {
      throw new NotFoundError(`Dimension '${dimension}' is not in cube '${cube}'.`, {
        details: { candidates: candidates(dimension, shape.dimensions.map((d) => d.name)) },
      });
    }
    // Resolve the level spec (same rule as query()): explicit level must be one of the
    // dimension's level specs (unknown → NotFoundError, candidates = its level specs); absent →
    // the first level; empty levels[] → [dim].MEMBERS fallback.
    let levelSpec: string | undefined;
    if (level) {
      const found = dim.levels.find((l) => l.spec === level);
      if (!found) throw new NotFoundError(`Level '${level}' is not in dimension '${dimension}' of cube '${cube}'.`, {
        details: { candidates: candidates(level, dim.levels.map((l) => l.spec)) },
      });
      levelSpec = found.spec;
    } else {
      levelSpec = dim.levels[0]?.spec;
    }
    const set = levelSpec ? `${levelSpec}.MEMBERS` : `[${dimension}].MEMBERS`;
    const mdx = `SELECT {${set}} ON 0 FROM [${cube}]`;
    const raw = await this.deepsee.mdxExecute(mdx);
    if (raw.Info?.Error) {
      throw new QueryError(`The member query was rejected: ${String(raw.Info.Error)}`, { details: { mdx, upstream: raw.Info.Error } });
    }
    const tuples = raw.Result?.Axes?.[0]?.Tuples ?? [];
    return tuples
      .map((t) => {
        const name = t.Members?.[0]?.Name ?? '';
        // The KEY form a KPI condition needs (`[level].&[key]`) is the MDX member
        // KEY. Live IRIS exposes it as MemberInfo[].memberKey (verified against
        // ProductInventoryCube: memberKey="Battery"); memberID is an internal
        // positional id ("Member_1") and would produce a `&[Member_1]` that does
        // not resolve. Omit key when absent so the formatter degrades to name form.
        const key = t.MemberInfo?.[0]?.memberKey;
        return key ? { name, key } : { name };
      })
      .filter((m) => m.name);
  }
}
