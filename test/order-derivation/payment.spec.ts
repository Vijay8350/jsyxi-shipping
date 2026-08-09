import { describe, expect, it } from 'vitest';
import {
  deriveCodOutstanding,
  derivePaymentMode,
} from '../../src/modules/order-derivation/payment';

/** §3.5 PAYMENT_MODE + F-15 order COD outstanding (§4.6). */

const COD_MAP = ['Cash on Delivery (COD)', 'Cash on Delivery', 'COD', 'cod', 'cash_on_delivery'];

describe('deriveCodOutstanding (F-15, §4.6)', () => {
  it('uses Shopify total_outstanding verbatim when carried — it IS F-17 − captured − refunds', () => {
    const result = deriveCodOutstanding({
      orderAmountF17: '1250.50',
      totalOutstandingShopMoney: '400.25',
      hasCodMappedGateway: true,
    });
    expect(result.codOutstanding).toBe('400.25');
    expect(result.basis).toBe('TOTAL_OUTSTANDING');
  });

  it('floors at 0 (§4.6): a negative outstanding never goes below zero', () => {
    const result = deriveCodOutstanding({
      orderAmountF17: '100.00',
      totalOutstandingShopMoney: '-25.00',
      hasCodMappedGateway: true,
    });
    expect(result.codOutstanding).toBe('0.00');
  });

  it('heuristic (documented week-4 choice): COD-mapped gateway, nothing captured → F-15 = F-17', () => {
    const result = deriveCodOutstanding({
      orderAmountF17: '1250.50',
      hasCodMappedGateway: true,
    });
    expect(result.codOutstanding).toBe('1250.50');
    expect(result.basis).toBe('COD_GATEWAY');
  });

  it('heuristic: all-prepaid gateways were paid at checkout → F-15 = 0', () => {
    const result = deriveCodOutstanding({
      orderAmountF17: '1250.50',
      hasCodMappedGateway: false,
    });
    expect(result.codOutstanding).toBe('0.00');
    expect(result.basis).toBe('PREPAID_GATEWAYS');
  });

  it('COD-mapped gateway with no F-17 → undetermined (§3.5 → UNRESOLVED), never a guess', () => {
    const result = deriveCodOutstanding({
      orderAmountF17: null,
      hasCodMappedGateway: true,
    });
    expect(result.codOutstanding).toBeNull();
    expect(result.basis).toBe('UNDETERMINED');
  });
});

describe('derivePaymentMode (§3.5, A1-03)', () => {
  it('COD requires BOTH a gateway match (S-14) AND F-15 > 0', () => {
    expect(
      derivePaymentMode({
        gatewayNames: ['Cash on Delivery (COD)'],
        codGatewayMap: COD_MAP,
        codOutstanding: '1250.50',
      }),
    ).toBe('COD');
  });

  it('a COD-mapped gateway with F-15 = 0 is PREPAID, not COD (§3.5)', () => {
    expect(
      derivePaymentMode({
        gatewayNames: ['Cash on Delivery (COD)'],
        codGatewayMap: COD_MAP,
        codOutstanding: '0.00',
      }),
    ).toBe('PREPAID');
  });

  it('PREPAID: all gateways prepaid and F-15 = 0', () => {
    expect(
      derivePaymentMode({
        gatewayNames: ['Razorpay', 'upi'],
        codGatewayMap: COD_MAP,
        codOutstanding: '0.00',
      }),
    ).toBe('PREPAID');
  });

  it('UNRESOLVED: the unmapped gateway (no gateway names at all)', () => {
    expect(
      derivePaymentMode({ gatewayNames: [], codGatewayMap: COD_MAP, codOutstanding: '0.00' }),
    ).toBe('UNRESOLVED');
  });

  it('UNRESOLVED: the mixed case — a COD-mapped gateway alongside a prepaid one', () => {
    expect(
      derivePaymentMode({
        gatewayNames: ['Cash on Delivery (COD)', 'Razorpay'],
        codGatewayMap: COD_MAP,
        codOutstanding: '1250.50',
      }),
    ).toBe('UNRESOLVED');
  });

  it('UNRESOLVED: a positive balance with only prepaid gateways cannot be explained', () => {
    expect(
      derivePaymentMode({
        gatewayNames: ['Razorpay'],
        codGatewayMap: COD_MAP,
        codOutstanding: '10.00',
      }),
    ).toBe('UNRESOLVED');
  });

  it('UNRESOLVED: COD-mapped gateway whose collectible balance cannot be determined', () => {
    expect(
      derivePaymentMode({
        gatewayNames: ['COD'],
        codGatewayMap: COD_MAP,
        codOutstanding: null,
      }),
    ).toBe('UNRESOLVED');
  });
});
