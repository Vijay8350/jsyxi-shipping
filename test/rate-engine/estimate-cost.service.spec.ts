import { describe, expect, it } from 'vitest';
import { EstimateCostService } from '../../src/modules/rate-engine/estimate-cost.service';
import type { EstimateCostInput } from '../../src/modules/rate-engine/rate-engine.types';
import { mockPool, routeBySql } from '../team/helpers';
import type { Pool } from 'pg';

/**
 * estimateCost (§9.15, §4.5) against a mocked Pool: the §4.4 worked example
 * end-to-end as a §8.3 QuoteResponse, plus the unpriceable paths (§4.1
 * zero/null guards → structured reasons, never a zero price).
 */

const SHOP_ID = '11111111-1111-1111-1111-111111111111';
const SERVICE_ID = '22222222-2222-2222-2222-222222222222';
const CARD_ID = '33333333-3333-3333-3333-333333333333';
const VERSION_ID = '44444444-4444-4444-4444-444444444444';
const ZONE_MAP_ID = '55555555-5555-5555-5555-555555555555';
const POSTAL_VERSION_ID = '66666666-6666-6666-6666-666666666666';

const INPUT: EstimateCostInput = {
  shopId: SHOP_ID,
  serviceId: SERVICE_ID,
  destinationPincode: '110001',
  deadWeightKg: '0.420', // §4.2 example A F-24
  lengthCm: '25.00',
  widthCm: '20.00',
  heightCm: '10.00',
  paymentMode: 'COD',
  collectible: '2000.00',
  declaredValue: '2000.00',
  shipDate: '2026-06-01',
};

const VERSION_ROW = {
  rate_card_version_id: VERSION_ID,
  rate_card_id: CARD_ID,
  effective_from: '2026-01-01',
  effective_to: null,
  zone_map_id: ZONE_MAP_ID,
  fuel_pct: '0.180000',
  cod_flat: '35.00',
  cod_pct: '0.020000',
  rto_basis: 'SAME_AS_FORWARD',
  rto_pct: null,
  gst_pct: '0.180000',
  component_order: ['F-5', 'F-6', 'F-7', 'F-8', 'F-9', 'F-10', 'F-11'],
  taxable_components: ['F-5', 'F-6', 'F-7', 'F-8'],
  is_sealed: false,
  version: 1,
};

function happyPathPool() {
  const { pool } = mockPool();
  routeBySql(pool.query, [
    ['FROM pickup_location', () => ({ rows: [{ pincode: '380015' }] })],
    ['FROM rate_card_version', () => ({ rows: [VERSION_ROW] })],
    ['FROM rate_card_slab', () => ({
      rows: [
        {
          slab_id: 'slab-1',
          rate_card_version_id: VERSION_ID,
          zone: 'C',
          base_weight_kg: '0.500',
          base_rate: '42.00',
          additional_step_kg: '0.500',
          additional_rate: '38.00',
        },
      ],
    })],
    ['FROM rate_card_component', () => ({ rows: [] })],
    ['FROM rate_card ', () => ({
      rows: [
        {
          rate_card_id: CARD_ID,
          shop_id: SHOP_ID,
          service_id: SERVICE_ID,
          courier_account_id: 'acct-1',
          name: 'Standard',
          version: 1,
        },
      ],
    })],
    ['FROM service_version', () => ({
      rows: [
        {
          service_version_id: 'sv-1',
          service_id: SERVICE_ID,
          effective_from: '2026-01-01',
          volumetric_divisor: '5000.0000',
          min_billable_kg: '0.500',
          billable_increment_kg: '0.500',
        },
      ],
    })],
    ['FROM commercial_zone_map', () => ({
      rows: [
        {
          zone_map_id: ZONE_MAP_ID,
          shop_id: SHOP_ID,
          service_id: SERVICE_ID,
          label: 'National',
          effective_from: '2026-01-01',
          postal_version_id: POSTAL_VERSION_ID,
          is_sealed: false,
          version: 1,
        },
      ],
    })],
    ['FROM commercial_zone_rule', () => ({
      rows: [
        {
          zone_rule_id: 'rule-1',
          zone_map_id: ZONE_MAP_ID,
          origin_matcher: { pincode: { prefix: '38' } },
          destination_matcher: { pincode: { prefix: '11' } },
          zone: 'C',
          position: 1,
        },
      ],
    })],
    ['FROM postal_pincode', (params) => ({
      rows: [
        {
          city: params?.[1] === '380015' ? 'Ahmedabad' : 'New Delhi',
          district: null,
          state: params?.[1] === '380015' ? 'Gujarat' : 'Delhi',
          region: null,
          is_metro: params?.[1] === '110001',
          is_special: false,
        },
      ],
    })],
  ]);
  return pool as unknown as Pool;
}

describe('estimateCost — §4.4 worked example end-to-end (§8.3 shape)', () => {
  it('synthesizes the QuoteResponse from F-5…F-11', async () => {
    const service = new EstimateCostService(happyPathPool());
    const result = await service.estimateCost(INPUT);

    expect(result.rateCardVersionId).toBe(VERSION_ID);
    expect(result.zoneMapId).toBe(ZONE_MAP_ID);

    const q = result.quote;
    expect(q.serviceable).toBe(true);
    expect(q.rateAvailable).toBe(true);
    expect(q.failureReasons).toEqual([]);
    expect(q.currency).toBe('INR');
    expect(q.total).toBe('158.59'); // the §4.4 worked example F-11
    expect(q.components).toEqual([
      { code: 'F-5', label: 'Base freight', amount: '80.00', taxable: true },
      { code: 'F-6', label: 'Fuel surcharge', amount: '14.40', taxable: true },
      { code: 'F-7', label: 'COD charge', amount: '40.00', taxable: true },
      { code: 'F-10', label: 'GST', amount: '24.19', taxable: false },
    ]);
    expect(q.rtoRule).toEqual({ basis: 'SAME_AS_FORWARD', pct: null });
    expect(q.eddSource).toBeNull(); // rate cards carry no EDD source (§8.3)
    expect(q.providerQuoteRef).toBeNull();
    expect(q.fetchedAt).toBeTruthy();
  });
});

describe('estimateCost — unpriceable paths (§4.1, §4.5 NONE behavior)', () => {
  const withRoutes = (routes: Array<[string, (params?: unknown[]) => unknown]>) => {
    const { pool } = mockPool();
    routeBySql(pool.query, routes);
    return new EstimateCostService(pool as unknown as Pool);
  };

  const baseRoutes = (): Array<[string, (params?: unknown[]) => unknown]> => [
    ['FROM pickup_location', () => ({ rows: [{ pincode: '380015' }] })],
    ['FROM rate_card_version', () => ({ rows: [VERSION_ROW] })],
    ['FROM rate_card_slab', () => ({ rows: [] })],
    ['FROM rate_card_component', () => ({ rows: [] })],
    ['FROM rate_card ', () => ({ rows: [{ rate_card_id: CARD_ID }] })],
    ['FROM service_version', () => ({
      rows: [{ volumetric_divisor: '5000.0000', min_billable_kg: '0.500', billable_increment_kg: '0.500' }],
    })],
    ['FROM commercial_zone_map', () => ({
      rows: [{ zone_map_id: ZONE_MAP_ID, postal_version_id: POSTAL_VERSION_ID }],
    })],
    ['FROM commercial_zone_rule', () => ({ rows: [] })],
    ['FROM postal_pincode', () => ({ rows: [] })],
  ];

  it('no rate card → RATE_CARD_MISSING', async () => {
    const service = withRoutes([
      ['FROM pickup_location', () => ({ rows: [{ pincode: '380015' }] })],
      ['FROM rate_card ', () => ({ rows: [] })],
    ]);
    const { quote } = await service.estimateCost(INPUT);
    expect(quote.rateAvailable).toBe(false);
    expect(quote.failureReasons).toEqual(['RATE_CARD_MISSING']);
  });

  it('no effective version for the ship date → RATE_CARD_VERSION_MISSING', async () => {
    const service = withRoutes([
      ['FROM pickup_location', () => ({ rows: [{ pincode: '380015' }] })],
      ['FROM rate_card_version', () => ({ rows: [] })],
      ['FROM rate_card ', () => ({ rows: [{ rate_card_id: CARD_ID }] })],
    ]);
    const { quote } = await service.estimateCost(INPUT);
    expect(quote.rateAvailable).toBe(false);
    expect(quote.failureReasons).toEqual(['RATE_CARD_VERSION_MISSING']);
  });

  it('null divisor → DIVISOR_MISSING, never a zero price', async () => {
    const service = withRoutes([
      ['FROM pickup_location', () => ({ rows: [{ pincode: '380015' }] })],
      ['FROM rate_card_version', () => ({ rows: [VERSION_ROW] })],
      ['FROM rate_card ', () => ({ rows: [{ rate_card_id: CARD_ID }] })],
      ['FROM service_version', () => ({
        rows: [{ volumetric_divisor: null, min_billable_kg: '0.500', billable_increment_kg: '0.500' }],
      })],
    ]);
    const { quote } = await service.estimateCost(INPUT);
    expect(quote.rateAvailable).toBe(false);
    expect(quote.failureReasons).toEqual(['DIVISOR_MISSING']);
  });

  it('no matching zone rule → serviceable false, ZONE_NOT_MATCHED', async () => {
    const service = withRoutes(baseRoutes());
    const { quote } = await service.estimateCost(INPUT);
    expect(quote.serviceable).toBe(false);
    expect(quote.rateAvailable).toBe(false);
    expect(quote.failureReasons).toEqual(['ZONE_NOT_MATCHED']);
  });

  it('zone resolved but no slab → serviceable true, rateAvailable false, SLAB_MISSING', async () => {
    const service = withRoutes(
      baseRoutes().map(([needle, handler]): [string, (params?: unknown[]) => unknown] =>
        needle === 'FROM commercial_zone_rule'
          ? [
              needle,
              () => ({
                rows: [
                  {
                    origin_matcher: {},
                    destination_matcher: {},
                    zone: 'C',
                    position: 1,
                  },
                ],
              }),
            ]
          : [needle, handler],
      ),
    );
    const { quote } = await service.estimateCost(INPUT);
    expect(quote.serviceable).toBe(true); // the lane resolves on the zone map
    expect(quote.rateAvailable).toBe(false); // …but the version cannot price it
    expect(quote.failureReasons).toEqual(['SLAB_MISSING']);
  });

  it('no active pickup location → ORIGIN_MISSING', async () => {
    const service = withRoutes([['FROM pickup_location', () => ({ rows: [] })]]);
    const { quote } = await service.estimateCost(INPUT);
    expect(quote.rateAvailable).toBe(false);
    expect(quote.failureReasons).toEqual(['ORIGIN_MISSING']);
  });
});
