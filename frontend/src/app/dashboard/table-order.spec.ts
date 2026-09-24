import { orderPopulatedFirst } from './table-order';
import type { ScObjectSummary } from '../services/sc-model.types';
import type { CountResult } from '../services/data-browser.service';

const obj = (className: string): ScObjectSummary =>
  ({ className, objectName: className.split('.').pop()! } as ScObjectSummary);
const ok = (total: number): CountResult => ({ ok: true, total } as CountResult);
const failed = (): CountResult => ({ ok: false, error: 'boom' } as CountResult);

describe('orderPopulatedFirst (Change 6 / M2)', () => {
  it('puts populated tables before empty ones, order preserved within each group', () => {
    const objects = [obj('X.Bom'), obj('X.Product'), obj('X.Issue'), obj('X.SalesOrderLine')];
    const counts: Record<string, CountResult> = {
      'X.Bom': ok(0), 'X.Product': ok(18), 'X.Issue': ok(0), 'X.SalesOrderLine': ok(2895),
    };
    expect(orderPopulatedFirst(objects, counts).map((o) => o.className))
      .toEqual(['X.Product', 'X.SalesOrderLine', 'X.Bom', 'X.Issue']);
  });

  it('groups unknown-count tables (loading or failed) with the populated group', () => {
    const objects = [obj('X.Empty'), obj('X.Loading'), obj('X.Failed'), obj('X.Full')];
    const counts: Record<string, CountResult> = {
      'X.Empty': ok(0), 'X.Failed': failed(), 'X.Full': ok(5),
      // 'X.Loading' has no entry yet
    };
    expect(orderPopulatedFirst(objects, counts).map((o) => o.className))
      .toEqual(['X.Loading', 'X.Failed', 'X.Full', 'X.Empty']);
  });
});
