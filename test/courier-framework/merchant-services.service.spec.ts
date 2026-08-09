import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { MerchantServicesService } from '../../src/modules/courier-framework/merchant-services.service';
import {
  ACCOUNT_ID,
  COURIER_ID,
  mockPool,
  routeBySql,
  SERVICE_ID,
  SHOP_ID,
} from './helpers';

/** Merchant services (§9.3.2): enable/disable per account with priority
 *  tiebreak; only enabled services are bookable (INV-7). */
const MS_ROW = {
  merchant_service_id: '66666666-6666-6666-6666-666666666666',
  courier_account_id: ACCOUNT_ID,
  service_id: SERVICE_ID,
  service_code: 'EXPRESS',
  service_name: 'Express',
  cost_source: 'RATE_CARD',
  enabled: true,
  priority_tiebreak_order: 2,
};

describe('MerchantServicesService (§9.3.2)', () => {
  let pool: ReturnType<typeof mockPool>['pool'];
  let service: MerchantServicesService;

  beforeEach(() => {
    ({ pool } = mockPool());
    service = new MerchantServicesService(pool as never);
  });

  function routeHappyPath() {
    routeBySql(pool.query, [
      [
        'FROM courier_account',
        () => ({ rows: [{ courier_id: COURIER_ID }], rowCount: 1 }),
      ],
      [
        'FROM service WHERE service_id',
        () => ({ rows: [{ service_id: SERVICE_ID }], rowCount: 1 }),
      ],
      ['INSERT INTO merchant_service', () => ({ rows: [], rowCount: 1 })],
      ['FROM merchant_service', () => ({ rows: [MS_ROW], rowCount: 1 })],
    ]);
  }

  it('enables a service via upsert with priority_tiebreak_order', async () => {
    routeHappyPath();
    const view = await service.setService(SHOP_ID, ACCOUNT_ID, SERVICE_ID, true, 2);
    expect(view.enabled).toBe(true);
    expect(view.priorityTiebreakOrder).toBe(2);
    const [sql, params] = pool.query.mock.calls.find(([s]: [string]) =>
      s.includes('INSERT INTO merchant_service'),
    ) as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (courier_account_id, service_id)');
    // INV-1: shop-scoped write, fully parameterized.
    expect(params[0]).toBe(SHOP_ID);
    expect(params[1]).toBe(ACCOUNT_ID);
  });

  it('disables a service on the same path', async () => {
    routeHappyPath();
    const view = await service.setService(SHOP_ID, ACCOUNT_ID, SERVICE_ID, false);
    const [, params] = pool.query.mock.calls.find(([s]: [string]) =>
      s.includes('INSERT INTO merchant_service'),
    ) as [string, unknown[]];
    expect(params[3]).toBe(false);
    expect(view.serviceId).toBe(SERVICE_ID);
  });

  it('rejects a service that does not belong to the account courier', async () => {
    routeBySql(pool.query, [
      [
        'FROM courier_account',
        () => ({ rows: [{ courier_id: COURIER_ID }], rowCount: 1 }),
      ],
      ['FROM service WHERE service_id', () => ({ rows: [], rowCount: 0 })],
    ]);
    await expect(
      service.setService(SHOP_ID, ACCOUNT_ID, SERVICE_ID, true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes every query to the shop (INV-1)', async () => {
    routeBySql(pool.query, [
      ['FROM courier_account', () => ({ rows: [], rowCount: 0 })],
    ]);
    await expect(
      service.setService('99999999-9999-9999-9999-999999999999', ACCOUNT_ID, SERVICE_ID, true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only enabled services are bookable (§9.3.2, INV-7)', async () => {
    routeBySql(pool.query, [
      ['FROM merchant_service', (params) => ({ rows: [{ '?column?': 1 }], rowCount: 1 })],
    ]);
    await expect(service.isBookable(SHOP_ID, ACCOUNT_ID, SERVICE_ID)).resolves.toBe(true);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('AND enabled');
    expect(params).toEqual([SHOP_ID, ACCOUNT_ID, SERVICE_ID]);
  });
});
