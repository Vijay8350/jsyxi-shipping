import { describe, expect, it } from 'vitest';
import {
  avgTatHours,
  deliveryRate,
  ndrRate,
  rtoRate,
} from '../../src/modules/dashboard/dashboard.types';

/**
 * §4.10 F-16 formulas — exact. Open shipments appear in neither F-16.a
 * term; a zero denominator yields null (nothing to rate), never a fake 0.
 */
describe('F-16 performance formulas (§4.10)', () => {
  it('F-16.a delivery rate = Delivered ÷ (Delivered + RTO Delivered)', () => {
    expect(deliveryRate(8, 2)).toBe(0.8);
    expect(deliveryRate(7, 3)).toBe(0.7);
    expect(deliveryRate(0, 5)).toBe(0);
    expect(deliveryRate(5, 0)).toBe(1);
  });

  it('F-16.a has no term for open shipments — they cannot enter the rate', () => {
    // deliveryRate takes only the two terminal outcomes; a cohort of 10
    // booked with 8 delivered / 2 RTO-delivered rates 0.8 no matter how
    // many are still open (open is reported separately by the caller).
    expect(deliveryRate.length).toBe(2);
    expect(deliveryRate(8, 2)).toBe(0.8);
  });

  it('F-16.a is null while the cohort has no terminal delivery outcome', () => {
    expect(deliveryRate(0, 0)).toBeNull();
  });

  it('F-16.b NDR rate = shipments with ≥1 NDR ÷ picked-up shipments', () => {
    expect(ndrRate(3, 10)).toBe(0.3);
    expect(ndrRate(0, 10)).toBe(0);
    expect(ndrRate(10, 10)).toBe(1);
    expect(ndrRate(3, 0)).toBeNull();
  });

  it('F-16.c RTO rate = RTO Delivered ÷ terminal shipments', () => {
    expect(rtoRate(2, 10)).toBe(0.2);
    expect(rtoRate(0, 10)).toBe(0);
    expect(rtoRate(2, 0)).toBeNull();
  });

  it('F-16.d TAT = mean calendar hours PICKED_UP → DELIVERED', () => {
    expect(avgTatHours(100, 4)).toBe(25);
    expect(avgTatHours(7.5, 2)).toBe(3.75);
    expect(avgTatHours(0, 0)).toBeNull();
  });
});
