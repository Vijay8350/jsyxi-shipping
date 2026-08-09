import { WorkingRecipient } from '../../src/modules/order-sync/working-values.types';

/** Shared fixtures for order-derivation specs. The MockTxPool / mockAudit
 *  doubles are reused from test/order-sync/helpers. */

export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const PICKUP_LOCATION_ID = '44444444-4444-4444-4444-444444444444';
export const PROFILE_SMALL_ID = '55555555-5555-5555-5555-555555555551';
export const PROFILE_MEDIUM_ID = '55555555-5555-5555-5555-555555555552';
export const PROFILE_BIG_ID = '55555555-5555-5555-5555-555555555553';

export function validRecipient(): WorkingRecipient {
  return {
    name: 'Asha Verma',
    addressLines: ['12, MG Road', 'Near Metro Gate 3'],
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    phone: '9876543210',
    email: 'buyer@example.in',
  };
}

/** A DRAFT shipment row as pg returns it (jsonb already parsed). */
export function draftShipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    booking_state: 'DRAFT',
    custody_state: 'NOT_APPLICABLE',
    movement_state: 'NOT_SHIPPED',
    awb_normalized: null,
    collectible: '0.00',
    pickup_location_id: PICKUP_LOCATION_ID,
    working_values: {
      schemaVersion: 1,
      recipient: validRecipient(),
      lines: [],
      payment: {
        mode: 'UNRESOLVED',
        gatewayNames: ['Cash on Delivery (COD)'],
        collectible: '0.00',
      },
      fulfillment: {
        sourceFulfillmentOrderGids: ['gid://shopify/FulfillmentOrder/1'],
        shopifyLocationGid: 'gid://shopify/Location/1',
        mergePath: 'CONSOLIDATED',
      },
    },
    ...overrides,
  };
}

/** package_profile rows (snake_case, as pg returns them). */
export function profileRows() {
  return [
    {
      package_profile_id: PROFILE_SMALL_ID,
      length_cm: '25.00',
      width_cm: '20.00',
      height_cm: '10.00',
      tare_kg: '0.040',
      is_default: true,
    },
    {
      package_profile_id: PROFILE_MEDIUM_ID,
      length_cm: '30.00',
      width_cm: '24.00',
      height_cm: '12.00',
      tare_kg: '0.080',
      is_default: false,
    },
  ];
}
