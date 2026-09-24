import { CUBE_ALLOWED_TYPES, kpiAllowedTypes } from './chart-source-types';
import { CAPABILITY_TYPES } from './chart-capability';

describe('chart-source-types (pure editorial allow-lists)', () => {
  it('CUBE excludes exactly solidgauge + bullet and keeps everything else in CAPABILITY_TYPES order', () => {
    expect(CUBE_ALLOWED_TYPES).not.toContain('solidgauge');
    expect(CUBE_ALLOWED_TYPES).not.toContain('bullet');
    expect(CUBE_ALLOWED_TYPES).toEqual(
      CAPABILITY_TYPES.filter((t) => t !== 'solidgauge' && t !== 'bullet'),
    );
    expect(CUBE_ALLOWED_TYPES).toHaveLength(CAPABILITY_TYPES.length - 2);
  });

  it('KPI scalar (no breakdown) offers gauge + bullet only', () => {
    expect(kpiAllowedTypes(false)).toEqual(['solidgauge', 'bullet']);
  });

  it('KPI with a breakdown offers the coherent single-series set', () => {
    expect(kpiAllowedTypes(true)).toEqual(['bar', 'column', 'line', 'pie', 'slope', 'divergingBar']);
  });

  it('every allow-list token is a member of CAPABILITY_TYPES (a subset selector, never a fork)', () => {
    const universe = new Set<string>(CAPABILITY_TYPES);
    for (const t of [...CUBE_ALLOWED_TYPES, ...kpiAllowedTypes(true), ...kpiAllowedTypes(false)]) {
      expect(universe.has(t)).toBe(true);
    }
  });

  it('superset invariant: each allow-list contains everything the advisor can recommend for that source', () => {
    // Locks spec §5.5 — no clamp is needed because the recommendation is always offered.
    // Scalar KPI: advisor derives solidgauge, or flips to bullet with target+bands.
    for (const rec of ['solidgauge', 'bullet']) expect(kpiAllowedTypes(false)).toContain(rec);
    // KPI breakdown (one series over categories): line / slope / divergingBar / bar shape-default.
    for (const rec of ['bar', 'line', 'slope', 'divergingBar']) expect(kpiAllowedTypes(true)).toContain(rec);
  });
});
