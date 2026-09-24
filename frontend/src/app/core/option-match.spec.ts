import { resolveOption } from './option-match';

/**
 * The guided-form dropdown resolver. Its job is to turn a plain term the user
 * typed in their question ("country", "revenue") into the dropdown's real
 * canonical option (`[customer].[H1].[country]`, `totalRevenue`) — the NER step
 * that stops the assistant from either hallucinating a nonexistent value or
 * giving up. These pins fix the behaviour tier by tier.
 */
describe('resolveOption — guided dropdown NER matcher', () => {
  const CUBE_DIMS = [
    { value: '[customer].[H1].[country]', labels: ['Country'] },
    { value: '[customer].[H1].[name]', labels: ['Customer Name'] },
    { value: '[orderStatus].[H1].[orderStatus]', labels: ['Order Status'] },
    { value: '[orderPlacedDate].[H1].[Year]', labels: ['Year'] },
  ];

  it('matches the MDX member from a plain trailing-level term ("country")', () => {
    const r = resolveOption('country', CUBE_DIMS);
    expect(r).toEqual({ status: 'matched', value: '[customer].[H1].[country]', exact: false });
  });

  it('matches the MDX member from its caption ("Order Status")', () => {
    const r = resolveOption('order status', CUBE_DIMS);
    expect(r).toEqual({ status: 'matched', value: '[orderStatus].[H1].[orderStatus]', exact: false });
  });

  it('treats a whole-string case-insensitive hit as exact', () => {
    const r = resolveOption('[customer].[H1].[COUNTRY]', CUBE_DIMS);
    expect(r).toEqual({ status: 'matched', value: '[customer].[H1].[country]', exact: true });
  });

  it('matches measures across case / spacing / punctuation', () => {
    const measures = ['totalOrderValue', 'averageOrderValue', 'maxOrderValue', '%COUNT'];
    expect(resolveOption('Total Order Value', measures)).toEqual({ status: 'matched', value: 'totalOrderValue', exact: false });
    expect(resolveOption('total_order_value', measures)).toEqual({ status: 'matched', value: 'totalOrderValue', exact: false });
  });

  it('resolves a partial term to the single containing option (weak tier)', () => {
    const measures = ['totalRevenue', 'orderCount'];
    expect(resolveOption('revenue', measures)).toEqual({ status: 'matched', value: 'totalRevenue', exact: false });
  });

  it('returns ambiguous (not a wrong guess) when several options are equally close', () => {
    // "order value" is a substring of three measures — the caller must ask, not pick.
    const measures = ['totalOrderValue', 'averageOrderValue', 'maxOrderValue'];
    const r = resolveOption('order value', measures);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates).toEqual(['totalOrderValue', 'averageOrderValue', 'maxOrderValue']);
    }
  });

  it('returns none when nothing is close enough', () => {
    expect(resolveOption('shippingCarrier', CUBE_DIMS)).toEqual({ status: 'none' });
  });

  it('does not latch a 1-2 char query onto everything (min length guard)', () => {
    // "or" would substring-match orderStatus/country/... — too short to be a signal.
    expect(resolveOption('or', CUBE_DIMS)).toEqual({ status: 'none' });
  });

  it('is empty-safe', () => {
    expect(resolveOption('', ['a', 'b'])).toEqual({ status: 'none' });
    expect(resolveOption('a', [])).toEqual({ status: 'none' });
  });

  it('prefers an exact canonical value over a fuzzy label collision', () => {
    // Both options mention "status"; an exact value hit must win and report exact.
    const opts = [
      { value: 'status', labels: ['Order Status'] },
      { value: '[orderStatus].[H1].[status]', labels: ['Status'] },
    ];
    expect(resolveOption('status', opts)).toEqual({ status: 'matched', value: 'status', exact: true });
  });
});
