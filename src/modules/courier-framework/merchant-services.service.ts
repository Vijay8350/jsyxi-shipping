import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

/**
 * Merchant services (§9.3.2): rules, rate cards, booking, labels, manifests
 * and reports all operate at Service level. The merchant enables the
 * Services on their contract per courier account; only enabled services are
 * bookable (INV-7). `priority_tiebreak_order` breaks ties in routing.
 */

export interface MerchantServiceView {
  merchantServiceId: string;
  courierAccountId: string;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  costSource: string;
  enabled: boolean;
  priorityTiebreakOrder: number;
}

@Injectable()
export class MerchantServicesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Verify the account belongs to the shop (INV-1) and return its courier. */
  private async accountCourier(shopId: string, courierAccountId: string): Promise<string> {
    const res = await this.pool.query(
      `SELECT courier_id FROM courier_account
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [courierAccountId, shopId],
    );
    if (res.rowCount === 0) throw new NotFoundException('courier account not found');
    return res.rows[0].courier_id as string;
  }

  async list(shopId: string, courierAccountId: string): Promise<MerchantServiceView[]> {
    await this.accountCourier(shopId, courierAccountId);
    const res = await this.pool.query(
      `SELECT ms.merchant_service_id, ms.courier_account_id, ms.service_id,
              s.code AS service_code, s.name AS service_name, s.cost_source,
              ms.enabled, ms.priority_tiebreak_order
         FROM merchant_service ms
         JOIN service s ON s.service_id = ms.service_id
        WHERE ms.shop_id = $1 AND ms.courier_account_id = $2
        ORDER BY ms.priority_tiebreak_order, s.code`,
      [shopId, courierAccountId],
    );
    return res.rows.map((r) => ({
      merchantServiceId: r.merchant_service_id,
      courierAccountId: r.courier_account_id,
      serviceId: r.service_id,
      serviceCode: r.service_code,
      serviceName: r.service_name,
      costSource: r.cost_source,
      enabled: r.enabled,
      priorityTiebreakOrder: r.priority_tiebreak_order,
    }));
  }

  /**
   * Enable/disable a service on an account (unique (courier_account_id,
   * service_id)) and set its priority tiebreak. Upserts: enabling a service
   * the merchant never touched creates the row.
   */
  async setService(
    shopId: string,
    courierAccountId: string,
    serviceId: string,
    enabled: boolean,
    priorityTiebreakOrder?: number,
  ): Promise<MerchantServiceView> {
    const courierId = await this.accountCourier(shopId, courierAccountId);
    const svc = await this.pool.query(
      `SELECT service_id FROM service WHERE service_id = $1 AND courier_id = $2`,
      [serviceId, courierId],
    );
    if (svc.rowCount === 0) {
      throw new NotFoundException('service not found for this courier');
    }
    try {
      await this.pool.query(
        `INSERT INTO merchant_service
           (shop_id, courier_account_id, service_id, enabled, priority_tiebreak_order)
         VALUES ($1, $2, $3, $4, COALESCE($5, 0))
         ON CONFLICT (courier_account_id, service_id)
         DO UPDATE SET enabled = EXCLUDED.enabled,
                       priority_tiebreak_order = COALESCE($5, merchant_service.priority_tiebreak_order),
                       version = merchant_service.version + 1`,
        [shopId, courierAccountId, serviceId, enabled, priorityTiebreakOrder ?? null],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('merchant service conflict');
      }
      throw err;
    }
    const rows = await this.list(shopId, courierAccountId);
    const found = rows.find((r) => r.serviceId === serviceId);
    if (!found) throw new NotFoundException('merchant service not found after write');
    return found;
  }

  /** Only enabled services are bookable (§9.3.2, INV-7). */
  async isBookable(shopId: string, courierAccountId: string, serviceId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM merchant_service
        WHERE shop_id = $1 AND courier_account_id = $2 AND service_id = $3 AND enabled`,
      [shopId, courierAccountId, serviceId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
