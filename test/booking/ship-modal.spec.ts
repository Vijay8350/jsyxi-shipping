import { describe, expect, it, vi } from 'vitest';
import { ShipModalService } from '../../src/modules/booking/ship-modal.service';
import {
  COURIER_ACCOUNT_ID,
  FnPool,
  MERCHANT_SERVICE_ID,
  ORDER_ID,
  PICKUP_LOCATION_ID,
  PROFILE_ID,
  SERVICE_ID,
  SHIPMENT_ID,
  SHOP_ID,
  orderRow,
  rateCardQuote,
  selectionRow,
  serviceVersionRow,
  shipmentRow,
  workingValues,
} from './helpers';

/**
 * The §9.5.1 ship modal: F-20 profile, F-24 with "no weight" lines,
 * per-candidate estimates (RATE_CARD engine / LIVE_QUOTE cache), EDD and the
 * §4.7 COD-split warning.
 */

function modalPool(opts: { siblings?: Record<string, unknown>[]; weight?: unknown } = {}) {
  const pool = new FnPool();
  pool.on(/SELECT shipment_id, order_id, booking_state/, [
    {
      shipment_id: SHIPMENT_ID,
      order_id: ORDER_ID,
      booking_state: 'DRAFT',
      pickup_location_id: PICKUP_LOCATION_ID,
      working_values: workingValues(opts.weight ? { weight: opts.weight } : {}),
    },
  ]);
  pool.on(/FROM "order" WHERE/, [orderRow()]);
  pool.on(/FROM pickup_location/, [{ pincode: '380015' }]);
  pool.on(/FROM package_profile/, [{ name: 'Small box' }]);
  pool.on(/shipment_id <> \$3/, opts.siblings ?? []);
  pool.on(/FROM merchant_service ms/, [
    selectionRow(),
    selectionRow({
      merchant_service_id: 'ms-live',
      service_id: 'svc-live',
      cost_source: 'LIVE_QUOTE',
      service_code: 'AIR',
    }),
  ]);
  pool.on(/FROM service_version/, [serviceVersionRow()]);
  return pool;
}

function makeService(pool: FnPool, cached: unknown) {
  const estimates = {
    estimateCost: vi.fn(() =>
      Promise.resolve({
        quote: rateCardQuote(),
        rateCardVersionId: 'rcv',
        zoneMapId: 'zm',
      }),
    ),
  };
  const quoteCache = {
    findFresh: vi.fn(() => Promise.resolve(cached)),
    fetchAndStore: vi.fn(() => Promise.resolve(rateCardQuote({ providerQuoteRef: 'fresh-1' }))),
  };
  const svc = new ShipModalService(pool.asPool(), estimates as never, quoteCache as never);
  return { svc, estimates, quoteCache };
}

describe('ShipModalService (§9.5.1)', () => {
  it('returns profile, F-24, per-candidate estimates and the COD info', async () => {
    const pool = modalPool();
    const { svc, estimates, quoteCache } = makeService(
      pool,
      rateCardQuote({ providerQuoteRef: 'cached-1' }),
    );
    const data = await svc.getShipModal(SHOP_ID, SHIPMENT_ID);

    // F-20 resolved profile with dims + tare.
    expect(data.packageProfile).toMatchObject({
      packageProfileId: PROFILE_ID,
      name: 'Small box',
      lengthCm: '25.00',
      tareKg: '0.040',
    });
    // F-24 block, no "no weight" lines here.
    expect(data.weight).toMatchObject({ deadWeightKg: '0.540', usedDefaultParcelWeight: false });
    expect(data.weight?.noWeightLines).toHaveLength(0);

    expect(data.candidates).toHaveLength(2);
    const [rateCard, live] = data.candidates;
    // RATE_CARD via the engine.
    expect(estimates.estimateCost).toHaveBeenCalled();
    expect(rateCard).toMatchObject({
      serviceId: SERVICE_ID,
      costSource: 'RATE_CARD',
      serviceable: true,
      fromCache: false,
    });
    expect(rateCard?.estimate).toMatchObject({ total: '94.40', currency: 'INR' });
    // LIVE_QUOTE served from the §4.5 cache (no re-fetch within S-16).
    expect(quoteCache.findFresh).toHaveBeenCalled();
    expect(quoteCache.fetchAndStore).not.toHaveBeenCalled();
    expect(live).toMatchObject({ costSource: 'LIVE_QUOTE', fromCache: true });

    // §4.7: booking first on this COD order would carry the full F-15.
    expect(data.cod).toMatchObject({
      orderCodOutstanding: '1250.50',
      siblingCount: 0,
      splitWarning: false,
      carrierShipmentId: null,
      thisShipmentWouldCarry: true,
    });
    expect(data.collectible).toBe('1250.50');
  });

  it('a stale cache entry is re-fetched and re-stored (§4.5, S-16)', async () => {
    const pool = modalPool();
    const { svc, quoteCache } = makeService(pool, null);
    const data = await svc.getShipModal(SHOP_ID, SHIPMENT_ID);
    expect(quoteCache.fetchAndStore).toHaveBeenCalledTimes(1);
    expect(data.candidates[1]).toMatchObject({ fromCache: false, serviceable: true });
  });

  it('§9.2.3 siblings: shows the carrier parcel and the plain COD-split warning', async () => {
    const pool = modalPool({
      siblings: [
        {
          shipment_id: 'sib-booked',
          booking_state: 'CONFIRMED',
          collectible: '1250.50',
          awb_normalized: 'DL001',
        },
      ],
    });
    const { svc } = makeService(pool, null);
    const data = await svc.getShipModal(SHOP_ID, SHIPMENT_ID);
    expect(data.cod).toMatchObject({
      siblingCount: 1,
      splitWarning: true,
      carrierShipmentId: 'sib-booked',
      thisShipmentWouldCarry: false,
    });
    // This sibling books prepaid-priced (F-7 = 0).
    expect(data.collectible).toBe('0.00');
  });

  it('INV-20: lines with no resolvable weight are called out', async () => {
    const pool = modalPool({
      weight: {
        deadWeightKg: '0.540',
        lineWeightTotalKg: '0.500',
        tareKg: '0.040',
        usedDefaultParcelWeight: false,
        lines: [
          {
            orderLineId: 'l1',
            sku: 'TEE',
            quantity: 2,
            perUnitWeightKg: '0.250',
            lineWeightKg: '0.500',
            source: 'SHOPIFY',
            noWeight: false,
          },
          {
            orderLineId: 'l2',
            sku: 'STICKER',
            quantity: 1,
            perUnitWeightKg: '0.000',
            lineWeightKg: '0.000',
            source: 'NONE',
            noWeight: true,
          },
        ],
      },
    });
    const { svc } = makeService(pool, null);
    const data = await svc.getShipModal(SHOP_ID, SHIPMENT_ID);
    expect(data.weight?.noWeightLines).toEqual([
      { orderLineId: 'l2', sku: 'STICKER', quantity: 1 },
    ]);
  });
});
