import { describe, expect, it } from 'vitest';
import {
  UnmappableOrderError,
  mapShopifyOrder,
  normalizeMoney,
} from '../../src/modules/order-sync/order-mapper';
import { sampleOrderPayload } from './helpers';

describe('mapShopifyOrder (§8.1 field mapping + ADD-06/07)', () => {
  it('maps the full order field set', () => {
    const mapped = mapShopifyOrder(sampleOrderPayload());
    expect(mapped.shopifyOrderGid).toBe('gid://shopify/Order/555000111');
    expect(mapped.shopifyOrderNumber).toBe('1042');
    expect(mapped.createdAtShopify).toBe('2026-07-20T10:15:00+05:30');
    // F-17 shop money; presentment display-only (A2-04).
    expect(mapped.orderAmount).toBe('1250.50');
    expect(mapped.presentmentAmount).toBe('1250.50');
    expect(mapped.presentmentCurrency).toBe('INR');
    expect(mapped.riskFlag).toBe('HIGH');
    expect(mapped.isTestOrder).toBe(false);
  });

  it('ADD-06/ADD-07: mirrors the buyer-selected shipping line title and shop-money amount', () => {
    const mapped = mapShopifyOrder(sampleOrderPayload());
    expect(mapped.checkoutShippingTitle).toBe('Express');
    expect(mapped.checkoutShippingAmount).toBe('80.00');
  });

  it('ADD-06/07: null when the order has no shipping lines', () => {
    const payload = { ...sampleOrderPayload(), shipping_lines: [] };
    const mapped = mapShopifyOrder(payload);
    expect(mapped.checkoutShippingTitle).toBeNull();
    expect(mapped.checkoutShippingAmount).toBeNull();
  });

  it('carries raw gateway names and does NOT derive payment mode (week-4 §3.5)', () => {
    const mapped = mapShopifyOrder(sampleOrderPayload());
    expect(mapped.gatewayNames).toEqual(['Cash on Delivery (COD)']);
    // The MappedOrder shape has no paymentMode field at all — the column
    // keeps its 'UNRESOLVED' default until the week-4 agent owns §3.5.
    expect('paymentMode' in mapped).toBe(false);
  });

  it('maps the RV-13 protected recipient set', () => {
    const mapped = mapShopifyOrder(sampleOrderPayload());
    expect(mapped.recipientSnapshot).toEqual({
      name: 'Asha Verma',
      addressLines: ['12, MG Road', 'Near Metro Gate 3'],
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      phone: '9876543210',
      email: 'buyer@example.in',
    });
  });

  it('missing shipping address → null snapshot, never a guess (§8.1, INV-7)', () => {
    const payload = { ...sampleOrderPayload(), shipping_address: null };
    const mapped = mapShopifyOrder(payload);
    expect(mapped.recipientSnapshot).toBeNull();
  });

  it('maps line items: sku/title/variant/qty/price/tags/per-unit weight/HSN', () => {
    const mapped = mapShopifyOrder(sampleOrderPayload());
    expect(mapped.lines).toHaveLength(2);
    const [tee, wrap] = mapped.lines;
    expect(tee).toMatchObject({
      shopifyLineGid: 'gid://shopify/LineItem/9001',
      sku: 'TEE-BLK-M',
      title: 'Cotton Tee',
      variant: 'Black / M',
      quantity: 2,
      unitPrice: '500.00',
      tags: ['summer', 'bestseller'],
      hsnCode: '6109',
      weightKgPerUnit: '0.250', // RV-02: per UNIT, 250 g
    });
    // HSN nullable; zero grams means "no resolvable weight", not 0 kg.
    expect(wrap?.hsnCode).toBeNull();
    expect(wrap?.weightKgPerUnit).toBeNull();
    expect(wrap?.tags).toEqual([]);
  });

  it('requires shopify_order_gid (fails loudly, INV-20 — never drops silently)', () => {
    expect(() => mapShopifyOrder({})).toThrow(UnmappableOrderError);
    // A bare numeric id still yields the deterministic GID form.
    expect(mapShopifyOrder({ id: 42 }).shopifyOrderGid).toBe('gid://shopify/Order/42');
  });

  it('risk flag absent → null (§8.1)', () => {
    const payload = { ...sampleOrderPayload(), risk_level: undefined };
    expect(mapShopifyOrder(payload).riskFlag).toBeNull();
    const withRisks = { ...payload, order_risks: [{ recommendation: 'cancel' }] };
    expect(mapShopifyOrder(withRisks).riskFlag).toBe('cancel');
  });
});

describe('normalizeMoney (§4.1 boundary, INV-15)', () => {
  it('normalizes to 2dp NUMERIC text without floats', () => {
    expect(normalizeMoney('1250.5')).toBe('1250.50');
    expect(normalizeMoney('0')).toBe('0.00');
    expect(normalizeMoney(' 12.34 ')).toBe('12.34');
  });

  it('rejects invalid and sub-paise input rather than guessing', () => {
    expect(normalizeMoney('abc')).toBeNull();
    expect(normalizeMoney('10.999')).toBeNull();
    expect(normalizeMoney(null)).toBeNull();
    expect(normalizeMoney('')).toBeNull();
  });
});
