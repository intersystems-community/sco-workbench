// backend/test/unit/chartable-kpis.test.ts
import { describe, it, expect } from 'vitest';
import { toChartableKpis } from '../../src/dashboard/chartable-kpis.js';
import type { KpiDefinition } from '../../src/kpi/kpi-definition.model.js';

const deepsee = (over: Partial<KpiDefinition> = {}): KpiDefinition => ({
  name: 'OnHand', label: 'On-Hand Units', type: 'DeepSee',
  deepseeKpiSpec: { cube: 'InvCube', valueType: 'raw', kpiDimensions: [{ name: 'quantityStatus', label: 'Status' }, { name: 'region' }] },
  ...over,
});

describe('toChartableKpis', () => {
  it('surfaces a DeepSee KPI as { name, label, dimensions[] } with humanized fallbacks', () => {
    expect(toChartableKpis([deepsee()])).toEqual([
      { name: 'OnHand', label: 'On-Hand Units', dimensions: [{ name: 'quantityStatus', label: 'Status' }, { name: 'region', label: 'Region' }] },
    ]);
  });

  it('falls back to the humanized name when a KPI carries no label', () => {
    expect(toChartableKpis([deepsee({ label: undefined })])[0]!.label).toBe('On Hand');
  });

  it('drops a KPI with no DeepSee spec (not chartable through the cube-value path)', () => {
    expect(toChartableKpis([{ name: 'Manual', type: 'Manual' } as KpiDefinition])).toEqual([]);
  });
});
