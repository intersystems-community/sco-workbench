// backend/test/unit/kpi-values.test.ts
import { describe, it, expect, vi } from 'vitest';
import { KpiValueReader } from '../../src/dashboard/kpi-values.js';
import { QueryError, NotFoundError } from '../../src/iris/iris-error.js';
import type { KpiValueClient, RawKpiValuesResult } from '../../src/iris/kpi-value-client.js';
import type { CubeShape, CubeShapeReader } from '../../src/dashboard/chart-data.js';
import type { KpiDefinition, KpiDimension } from '../../src/kpi/kpi-definition.model.js';

const okScalar: RawKpiValuesResult = { status: 200, body: { kpiName: 'K', values: [{ label: 'kpi', value: 35 }] } };
const okExpanded: RawKpiValuesResult = {
  status: 200,
  body: { kpiName: 'K', expandDimension: 'status', values: [{ label: 'AboveMaximum', value: 11 }, { label: 'Normal', value: null }] },
};
const err500: RawKpiValuesResult = { status: 500, body: { Status: 'Error', Message: 'ERROR #5001: Empty or invalid WHERE clause' } };
const notFound: RawKpiValuesResult = { status: 404, body: { Status: 'Error', Message: 'KPI not defined (K).' } };

const fakeClient = (r: RawKpiValuesResult) => ({ values: vi.fn(async () => r) }) satisfies KpiValueClient & { values: ReturnType<typeof vi.fn> };

// The short REST `name` DELIBERATELY differs from the MDX dimension id inside
// `cubeDimension` (`status` vs `[quantityStatus]`, `placed` vs `[orderDate]`), so a
// test that passes proves the reader matches on the cubeDimension SEGMENT, not on name.
const kpiDef = (dims: KpiDimension[] = []): KpiDefinition => ({
  name: 'K', label: 'On-Hand', type: 'DeepSee',
  deepseeKpiSpec: { cube: 'InvCube', valueType: 'raw', kpiDimensions: dims },
});
const fakeDefs = (def: KpiDefinition | null) => ({ get: vi.fn(async () => def) });

// The cube's shape dimension NAMES are first-MDX-segments (as cube-catalog-ops emits them).
const cubeShape: CubeShape = {
  cube: 'InvCube',
  measures: [{ name: 'Total' }],
  dimensions: [{ name: 'quantityStatus', kind: 'categorical', levels: [] }, { name: 'orderDate', kind: 'temporal', levels: [] }],
};
const fakeShapeReader: CubeShapeReader = { shape: async () => cubeShape };

describe('KpiValueReader — normalize to ChartData', () => {
  it('a scalar KPI → dimensionKind scalar, one category, one series, def.label as valueLabel', async () => {
    // The def is read on BOTH paths so titling is consistent (D3-PLAN-03): def.label wins here too.
    const reader = new KpiValueReader(fakeClient(okScalar), fakeDefs(kpiDef()), fakeShapeReader);
    const data = await reader.values({ kpi: 'K' });
    expect(data.meta.dimensionKind).toBe('scalar');
    expect(data.categories).toEqual(['kpi']);
    expect(data.series).toEqual([{ name: 'On-Hand', data: [35] }]); // def.label, SAME as the expanded path
    expect(data.meta.valueLabel).toBe('On-Hand');
  });

  it('a scalar KPI with no definition available falls back to the humanized name', async () => {
    const reader = new KpiValueReader(fakeClient(okScalar), fakeDefs(null), fakeShapeReader);
    const data = await reader.values({ kpi: 'onHandUnits' });
    expect(data.meta.valueLabel).toBe('On Hand Units'); // degrade, not fail
    expect(data.series[0]!.name).toBe('On Hand Units');
  });

  it('an expanded KPI → categories = member labels, one series, category/value labels', async () => {
    const reader = new KpiValueReader(
      fakeClient(okExpanded),
      fakeDefs(kpiDef([{ name: 'status', label: 'Quantity Status', cubeDimension: '[quantityStatus].[H1].[Status]' }])),
      fakeShapeReader,
    );
    const data = await reader.values({ kpi: 'K', expandDimension: 'status' });
    expect(data.categories).toEqual(['AboveMaximum', 'Normal']);
    expect(data.series).toEqual([{ name: 'On-Hand', data: [11, null] }]); // def.label wins; NULL stays null
    expect(data.meta.categoryLabel).toBe('Quantity Status'); // the dim's own label
    expect(data.meta.valueLabel).toBe('On-Hand');
    expect(data.meta.dimensionKind).toBe('categorical'); // [quantityStatus] matches the categorical shape dim
  });

  it('an expanded KPI over a TEMPORAL backing dim is matched by cubeDimension, NOT by name', async () => {
    // name='placed' matches NOTHING in the shape; cubeDimension's segment [orderDate] matches the temporal dim.
    const reader = new KpiValueReader(
      fakeClient({ status: 200, body: { kpiName: 'K', expandDimension: 'placed', values: [{ label: '2026', value: 5 }] } }),
      fakeDefs(kpiDef([{ name: 'placed', label: 'Placed', cubeDimension: '[orderDate].[H1].[Year]' }])),
      fakeShapeReader,
    );
    expect((await reader.values({ kpi: 'K', expandDimension: 'placed' })).meta.dimensionKind).toBe('temporal');
  });

  it('matching by name alone would MISS the temporal dim — guarding the D3-PLAN-01 regression', async () => {
    // Same fixture, but if the reader keyed on `name` ('placed') it would fail to match and
    // wrongly return 'categorical'. This asserts the cubeDimension segment is what is used.
    const reader = new KpiValueReader(
      fakeClient({ status: 200, body: { kpiName: 'K', expandDimension: 'placed', values: [{ label: '2026', value: 5 }] } }),
      fakeDefs(kpiDef([{ name: 'placed', label: 'Placed', cubeDimension: '[orderDate].[H1].[Year]' }])),
      fakeShapeReader,
    );
    expect((await reader.values({ kpi: 'K', expandDimension: 'placed' })).meta.dimensionKind).not.toBe('categorical');
  });

  it('an expanded KPI whose backing dim cannot be matched degrades to categorical (never guesses temporal)', async () => {
    const reader = new KpiValueReader(
      fakeClient(okExpanded),
      fakeDefs(kpiDef([{ name: 'status', label: 'Quantity Status', cubeDimension: '[quantityStatus].[H1].[Status]' }])),
      { shape: async () => { throw new Error('no cube'); } },
    );
    expect((await reader.values({ kpi: 'K', expandDimension: 'status' })).meta.dimensionKind).toBe('categorical');
  });

  it('SC-2643: a 500 with body.Status==="Error" → QueryError (422), cause-agnostic, carrying body.Message', async () => {
    const reader = new KpiValueReader(fakeClient(err500), fakeDefs(kpiDef()), fakeShapeReader);
    await expect(reader.values({ kpi: 'BadKpi' })).rejects.toBeInstanceOf(QueryError);
    // Detection is the (status, body.Status) predicate, NOT an <INVALID OREF> substring.
    try {
      await reader.values({ kpi: 'BadKpi' });
    } catch (e) {
      const err = e as QueryError;
      expect(err.message).not.toContain('INVALID OREF');
      expect((err.details as { upstream?: string }).upstream).toContain('ERROR #5001');
    }
  });

  it('not-found keys off body.Status on the values endpoint → NotFoundError', async () => {
    const reader = new KpiValueReader(fakeClient(notFound), fakeDefs(kpiDef()), fakeShapeReader);
    await expect(reader.values({ kpi: 'K' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a bad expandDimension is rejected BEFORE the values call (the silent-swallow guard)', async () => {
    const client = fakeClient(okScalar);
    const reader = new KpiValueReader(client, fakeDefs(kpiDef([{ name: 'status', cubeDimension: '[quantityStatus].[H1].[Status]' }])), fakeShapeReader);
    await expect(reader.values({ kpi: 'K', expandDimension: 'NoSuchDim' })).rejects.toBeInstanceOf(NotFoundError);
    expect(client.values).not.toHaveBeenCalled(); // never let IRIS silently degrade to a scalar
  });

  it('an expand on a KPI that does not exist (def is null) → NotFoundError', async () => {
    const reader = new KpiValueReader(fakeClient(okScalar), fakeDefs(null), fakeShapeReader);
    await expect(reader.values({ kpi: 'Ghost', expandDimension: 'status' })).rejects.toBeInstanceOf(NotFoundError);
  });
});

import { deriveBands } from '../../src/dashboard/kpi-values.js';

describe('deriveBands — bullet polarity derived from the two thresholds', () => {
  it('lower-is-better (warning > watching): bands ascend ok → watching → warning', () => {
    // e.g. late-orders: watching 5, warning 10. Danger is the HIGH end.
    const r = deriveBands(5, 10)!;
    expect(r.target).toBe(5); // the watching threshold is the reference marker
    expect(r.bands).toEqual([
      { to: 5, kind: 'ok' },
      { to: 10, kind: 'watching' },
      { to: Infinity, kind: 'warning' },
    ]);
  });

  it('higher-is-better (warning < watching): kind order FLIPS so the danger zone is the low end', () => {
    // e.g. fill-rate: watching 90, warning 80. Danger is the LOW end. `to` stays ascending.
    const r = deriveBands(90, 80)!;
    expect(r.target).toBe(90);
    expect(r.bands).toEqual([
      { to: 80, kind: 'warning' },
      { to: 90, kind: 'watching' },
      { to: Infinity, kind: 'ok' },
    ]);
  });

  it('indeterminate polarity yields null (one threshold, or equal thresholds → no bullet)', () => {
    expect(deriveBands(5, undefined)).toBeNull();
    expect(deriveBands(undefined, 10)).toBeNull();
    expect(deriveBands(5, 5)).toBeNull();
    expect(deriveBands(undefined, undefined)).toBeNull();
  });

  it('a single threshold gives no bullet — NO fallback to warning-only (both are required)', () => {
    // Polarity + bands both need the PAIR; one threshold is indeterminate. There is no
    // target-only bullet — deriveBands returns null, the value degrades to a gauge.
    expect(deriveBands(undefined, 10)).toBeNull();
    expect(deriveBands(5, undefined)).toBeNull();
  });
});

describe('KpiValueReader — bullet side-channel on the scalar path', () => {
  it('a scalar KPI with two unequal thresholds carries meta.target + meta.bands', async () => {
    const def: KpiDefinition = { name: 'LateOrders', label: 'Late Orders', watchingThreshold: 5, warningThreshold: 10 };
    const client = { values: async () => ({ status: 200, body: { Status: 'OK', values: [{ label: 'Late Orders', value: 7 }] } }) };
    const reader = new KpiValueReader(client as any, { get: async () => def } as any, { shape: async () => ({ cube: 'C', measures: [], dimensions: [] }) });
    const data = await reader.values({ kpi: 'LateOrders' });
    expect(data.meta.target).toBe(5);
    expect(data.meta.bands).toEqual([
      { to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: Infinity, kind: 'warning' },
    ]);
  });

  it('a scalar KPI with no thresholds carries neither target nor bands (no bullet)', async () => {
    const def: KpiDefinition = { name: 'OnHand', label: 'On Hand' };
    const client = { values: async () => ({ status: 200, body: { Status: 'OK', values: [{ label: 'On Hand', value: 8016 }] } }) };
    const reader = new KpiValueReader(client as any, { get: async () => def } as any, { shape: async () => ({ cube: 'C', measures: [], dimensions: [] }) });
    const data = await reader.values({ kpi: 'OnHand' });
    expect(data.meta.target).toBeUndefined();
    expect(data.meta.bands).toBeUndefined();
  });

  it('bands are NOT added on the expanded (breakdown) path — only the scalar value gets a bullet', async () => {
    const def: KpiDefinition = { name: 'LateOrders', label: 'Late Orders', watchingThreshold: 5, warningThreshold: 10,
      deepseeKpiSpec: { cube: 'C', valueType: 'raw', kpiDimensions: [{ name: 'carrier', label: 'Carrier' }] } };
    const client = { values: async () => ({ status: 200, body: { Status: 'OK', values: [{ label: 'UPS', value: 3 }, { label: 'FedEx', value: 6 }] } }) };
    const reader = new KpiValueReader(client as any, { get: async () => def } as any, { shape: async () => ({ cube: 'C', measures: [], dimensions: [{ name: 'carrier', kind: 'categorical', levels: [] }] }) });
    const data = await reader.values({ kpi: 'LateOrders', expandDimension: 'carrier' });
    expect(data.meta.target).toBeUndefined();
    expect(data.meta.bands).toBeUndefined();
  });

  it('a definition read failure degrades to no target (never fails the value read)', async () => {
    const client = { values: async () => ({ status: 200, body: { Status: 'OK', values: [{ label: 'v', value: 1 }] } }) };
    const reader = new KpiValueReader(client as any, { get: async () => { throw new Error('def read down'); } } as any, { shape: async () => ({ cube: 'C', measures: [], dimensions: [] }) });
    const data = await reader.values({ kpi: 'X' });
    expect(data.meta.target).toBeUndefined();
    expect(data.series[0]!.data).toEqual([1]); // the value read is unaffected
  });

  it('a percentage KPI def → meta.unit = "percent" (scalar path)', async () => {
    const pctDef: KpiDefinition = { name: 'K', label: 'Fill Rate', type: 'DeepSee', deepseeKpiSpec: { cube: 'InvCube', valueType: 'percentage' } };
    const reader = new KpiValueReader(fakeClient(okScalar), fakeDefs(pctDef), fakeShapeReader);
    const data = await reader.values({ kpi: 'K' });
    expect(data.meta.unit).toBe('percent');
  });

  it('a raw KPI def → meta.unit is absent (byte-identical to today)', async () => {
    const reader = new KpiValueReader(fakeClient(okScalar), fakeDefs(kpiDef()), fakeShapeReader);
    const data = await reader.values({ kpi: 'K' });
    expect(data.meta.unit).toBeUndefined();
  });
});

import { statusOf } from '../../src/dashboard/kpi-values.js';

describe('statusOf — which band a value falls in (polarity-agnostic; §4a)', () => {
  // lower-is-better bands (deriveBands(5,10)): [{to:5,ok},{to:10,watching},{to:Infinity,warning}]
  const lowerBetter = [{ to: 5, kind: 'ok' as const }, { to: 10, kind: 'watching' as const }, { to: Infinity, kind: 'warning' as const }];
  // higher-is-better bands (deriveBands(90,80)): [{to:80,warning},{to:90,watching},{to:Infinity,ok}]
  const higherBetter = [{ to: 80, kind: 'warning' as const }, { to: 90, kind: 'watching' as const }, { to: Infinity, kind: 'ok' as const }];

  it('below the lowest bound → the first band', () => {
    expect(statusOf(3, lowerBetter)).toBe('ok');
    expect(statusOf(50, higherBetter)).toBe('warning');
  });
  it('on a boundary uses <= (the LOWER band, documented)', () => {
    expect(statusOf(5, lowerBetter)).toBe('ok');
    expect(statusOf(10, lowerBetter)).toBe('watching');
    expect(statusOf(80, higherBetter)).toBe('warning');
  });
  it('in the open-ended terminal band', () => {
    expect(statusOf(1000, lowerBetter)).toBe('warning');
    expect(statusOf(1000, higherBetter)).toBe('ok');
  });
  it('accepts a null terminal `to` (the wire form) as unbounded', () => {
    expect(statusOf(1000, [{ to: 5, kind: 'ok' }, { to: null, kind: 'warning' }])).toBe('warning');
  });
  it('null / undefined value → null; empty or missing bands → null', () => {
    expect(statusOf(null, lowerBetter)).toBeNull();
    expect(statusOf(undefined, lowerBetter)).toBeNull();
    expect(statusOf(5, [])).toBeNull();
    expect(statusOf(5, undefined)).toBeNull();
  });
});
