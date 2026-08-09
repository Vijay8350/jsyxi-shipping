import type { BookingSnapshot } from '../../src/modules/booking/booking.types';
import {
  DEFAULT_LABEL_TOGGLES,
  LabelTemplateRow,
  LabelToggles,
} from '../../src/modules/labels/labels.types';
import type { LabelRenderInput } from '../../src/modules/labels/label-pdf';
import type { ObjectStore } from '../../src/modules/booking-ops/object-store';

export { FnPool, mockAudit, SHOP_ID, OTHER_SHOP_ID, MEMBER_ID } from '../booking-ops/helpers';

export const TEMPLATE_ID = '77777777-7777-7777-7777-777777777777';
export const DOCUMENT_ID = 'dddddddd-0000-0000-0000-00000000000d';
export const JOB_ID = '99999999-9999-9999-9999-999999999999';
export const SHIPMENT_A = '33333333-3333-3333-3333-33333333333a';
export const SHIPMENT_B = '33333333-3333-3333-3333-33333333333b';
export const SHIPMENT_C = '33333333-3333-3333-3333-33333333333c';
export const SHIPMENT_D = '33333333-3333-3333-3333-33333333333d';
export const SHIPMENT_E = '33333333-3333-3333-3333-33333333333e';
export const ORDER_ID = '22222222-2222-2222-2222-222222222221';
export const SERVICE_ALPHA = '66666666-6666-6666-6666-6666666666a1';
export const SERVICE_ZETA = '66666666-6666-6666-6666-6666666666a2';
export const SERVICE_MID = '66666666-6666-6666-6666-6666666666a3';
export const COURIER_ACCOUNT_1 = '88888888-8888-8888-8888-888888888881';

/** In-memory ObjectStore double (put + getSignedUrl only). */
export function memoryStore() {
  const objects = new Map<string, Buffer>();
  const store: ObjectStore = {
    put: (key, bytes) => {
      objects.set(key, Buffer.from(bytes));
      return Promise.resolve();
    },
    getSignedUrl: (key, ttl) => Promise.resolve(`/signed/${key}?ttl=${ttl}`),
  };
  return { store, objects };
}

/** A §2.9-shaped frozen snapshot for renderer/service tests. */
export function snapshot(overrides: Record<string, unknown> = {}): BookingSnapshot {
  return {
    schemaVersion: 1,
    frozenAt: '2026-08-01T10:00:00.000Z',
    recipient: {
      name: 'Asha Verma',
      addressLines: ['12, MG Road'],
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      phone: '9876543210',
      email: 'buyer@example.in',
    },
    lines: [
      {
        orderLineId: 'ol-1',
        shopifyLineGid: null,
        sku: 'TEE-BLK-M',
        title: 'Cotton Tee',
        variant: 'Black / M',
        quantity: 2,
        unitPrice: '499.00',
        tags: [],
        hsnCode: '6109',
      },
    ],
    pickupLocation: {
      pickupLocationId: '44444444-4444-4444-4444-444444444444',
      name: 'Bengaluru Warehouse',
      contactName: null,
      phone: null,
      addressLines: ['1, Industrial Estate'],
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560058',
      gstin: '29ABCDE1234F1Z5',
    },
    packageProfile: {
      packageProfileId: '55555555-5555-5555-5555-555555555555',
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      tareKg: '0.040',
      source: 'DEFAULT',
    },
    payment: { mode: 'COD', collectible: '1250.50', currency: 'INR' },
    weights: {
      deadWeightKg: '0.540',
      lineWeightTotalKg: '0.500',
      usedDefaultParcelWeight: false,
      tareKg: '0.040',
      perLine: [],
      volumetricWeightKg: '1.000',
      rawChargeableKg: '1.000',
      billableWeightKg: '1.000',
    },
    service: {
      serviceId: SERVICE_ALPHA,
      serviceVersionId: null,
      code: 'AL',
      name: 'Alpha Express',
      costSource: 'RATE_CARD',
      volumetricDivisor: '5000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    },
    courierAccount: { courierAccountId: COURIER_ACCOUNT_1, mode: 'LIVE' },
    rateCardVersionId: null,
    zoneMapId: null,
    zone: 'B',
    formulaInputs: {
      shipDate: '2026-08-01',
      pieces: 1,
      originPincode: '560058',
      destinationPincode: '560001',
      deadWeightKg: '0.540',
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      paymentMode: 'COD',
      collectible: '1250.50',
      declaredValue: '998.00',
      zone: 'B',
      billableWeightKg: '1.000',
    },
    expectedQuote: null,
    shopify: { orderGid: 'gid://shopify/Order/1', lineGids: [], fulfillmentOrderGids: [] },
    rule: null,
    ...overrides,
  } as BookingSnapshot;
}

export function toggles(overrides: Partial<LabelToggles> = {}): LabelToggles {
  return { ...DEFAULT_LABEL_TOGGLES, ...overrides };
}

export function renderInput(overrides: Partial<LabelRenderInput> = {}): LabelRenderInput {
  return {
    snapshot: snapshot(),
    awb: 'AWB123456789',
    orderNumber: '1001',
    template: {
      brandName: 'Jsyxi Stores',
      supportPhone: '08012345678',
      messageLine: 'Thank you for shopping with us',
      toggles: toggles(),
    },
    isTest: false,
    ...overrides,
  };
}

export function templateRow(overrides: Record<string, unknown> = {}): LabelTemplateRow {
  return {
    template_id: TEMPLATE_ID,
    shop_id: '11111111-1111-1111-1111-111111111111',
    logo_object_key: null,
    brand_name: 'Jsyxi Stores',
    support_phone: '08012345678',
    message_line: 'Thank you for shopping with us',
    toggles: toggles(),
    size: 'THERMAL_4X6',
    version: 1,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as LabelTemplateRow;
}
