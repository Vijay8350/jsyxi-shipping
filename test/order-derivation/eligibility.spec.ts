import { describe, expect, it } from 'vitest';
import {
  EligibilityInput,
  evaluateEligibility,
} from '../../src/modules/order-derivation/eligibility';

/** INV-7 hard-blocks (§3.1, §9.2.1, §9.2.4): each block flips READY →
 *  INCOMPLETE, and fixing it flips back. */

function readyInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    recipient: {
      name: 'Asha Verma',
      addressLines: ['12, MG Road'],
      pincode: '560001',
      phone: '9876543210',
    },
    allocatedLineCount: 2,
    deadWeightKg: '0.540',
    dimensionsCm: { lengthCm: '25.00', widthCm: '20.00', heightCm: '10.00' },
    pickupLocationId: '44444444-4444-4444-4444-444444444444',
    paymentMode: 'COD',
    collectible: '1250.50',
    ...overrides,
  };
}

describe('evaluateEligibility (INV-7)', () => {
  it('all conditions met → READY (and the weeks 4–6 stubs pass with TODOs)', () => {
    const result = evaluateEligibility(readyInput());
    expect(result.ready).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('recipient blocks: missing name / address / pincode / phone', () => {
    expect(evaluateEligibility(readyInput({ recipient: null })).failures).toEqual([
      'RECIPIENT_NAME',
      'RECIPIENT_ADDRESS',
      'RECIPIENT_PINCODE',
      'RECIPIENT_PHONE',
    ]);
    expect(
      evaluateEligibility(readyInput({ recipient: { ...readyInput().recipient!, name: '  ' } })).failures,
    ).toEqual(['RECIPIENT_NAME']);
    expect(
      evaluateEligibility(readyInput({ recipient: { ...readyInput().recipient!, addressLines: [] } })).failures,
    ).toEqual(['RECIPIENT_ADDRESS']);
    // 6-digit Indian pincode (INV-7).
    expect(
      evaluateEligibility(readyInput({ recipient: { ...readyInput().recipient!, pincode: '56001' } })).failures,
    ).toEqual(['RECIPIENT_PINCODE']);
    // 10-digit phone (INV-7).
    expect(
      evaluateEligibility(readyInput({ recipient: { ...readyInput().recipient!, phone: '12345' } })).failures,
    ).toEqual(['RECIPIENT_PHONE']);
  });

  it('phone normalization: +91 / leading-0 / spaced forms all count as 10-digit', () => {
    for (const phone of ['+91 98765 43210', '09876543210', '+919876543210', '98765 43210']) {
      const result = evaluateEligibility(
        readyInput({ recipient: { ...readyInput().recipient!, phone } }),
      );
      expect(result.failures).not.toContain('RECIPIENT_PHONE');
    }
  });

  it('allocated lines with positive quantity', () => {
    expect(evaluateEligibility(readyInput({ allocatedLineCount: 0 })).failures).toEqual([
      'ALLOCATED_LINES',
    ]);
  });

  it('positive F-24 parcel weight and positive dimensions', () => {
    expect(evaluateEligibility(readyInput({ deadWeightKg: '0.000' })).failures).toEqual([
      'POSITIVE_WEIGHT',
    ]);
    expect(evaluateEligibility(readyInput({ deadWeightKg: null })).failures).toContain(
      'POSITIVE_WEIGHT',
    );
    expect(evaluateEligibility(readyInput({ dimensionsCm: null })).failures).toEqual([
      'POSITIVE_DIMENSIONS',
    ]);
    expect(
      evaluateEligibility(
        readyInput({ dimensionsCm: { lengthCm: '0.00', widthCm: '20.00', heightCm: '10.00' } }),
      ).failures,
    ).toEqual(['POSITIVE_DIMENSIONS']);
  });

  it('pickup location present', () => {
    expect(evaluateEligibility(readyInput({ pickupLocationId: null })).failures).toEqual([
      'PICKUP_LOCATION',
    ]);
  });

  it('resolved payment mode and Collectible', () => {
    expect(evaluateEligibility(readyInput({ paymentMode: 'UNRESOLVED' })).failures).toEqual([
      'PAYMENT_MODE',
    ]);
    expect(evaluateEligibility(readyInput({ collectible: null })).failures).toEqual(['COLLECTIBLE']);
    // PREPAID with a zero collectible is resolved and bookable.
    expect(evaluateEligibility(readyInput({ paymentMode: 'PREPAID', collectible: '0.00' })).ready).toBe(true);
  });

  it('fixing the block flips INCOMPLETE back to READY (§3.1 reversibility)', () => {
    const broken = readyInput({ pickupLocationId: null, paymentMode: 'UNRESOLVED' });
    expect(evaluateEligibility(broken).ready).toBe(false);
    const fixed = readyInput();
    expect(evaluateEligibility(fixed).ready).toBe(true);
  });
});
