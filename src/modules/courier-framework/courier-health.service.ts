import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { PG_POOL } from '../../database/database.module';

/**
 * §3.21 COURIER_ACCOUNT_HEALTH transitions driven by the transport policy.
 * UNVERIFIED until the first successful test-connection call; DEGRADED on
 * repeated non-auth errors or an open circuit breaker; DISCONNECTED on an
 * authentication or token-refresh failure; DISABLED when the merchant
 * switches the account off. None is terminal (RW-17).
 *
 * The courier-disconnected alert itself is a §9.21 notifications concern —
 * here we only set the state and audit it (§12) with actor SYSTEM, since no
 * HTTP actor is involved.
 */

export type CourierAccountHealth =
  | 'UNVERIFIED'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'DISCONNECTED'
  | 'DISABLED';

@Injectable()
export class CourierHealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** Set the health state if it differs, auditing the transition (§12).
   *  Returns true when a transition happened. */
  async transition(
    courierAccountId: string,
    shopId: string,
    to: CourierAccountHealth,
    reason: string,
  ): Promise<boolean> {
    // A DISABLED account only leaves DISABLED through the merchant's explicit
    // enable action, never as a side effect of transport noise (§3.21).
    // The CTE captures the prior state so the audit row carries a true
    // before/after (§12).
    const res = await this.pool.query(
      `WITH old AS (
         SELECT health_state FROM courier_account
          WHERE courier_account_id = $1 AND shop_id = $2
       )
       UPDATE courier_account ca
          SET health_state = $3
         FROM old
        WHERE ca.courier_account_id = $1
          AND ca.shop_id = $2
          AND ca.health_state <> $3
          AND ca.health_state <> 'DISABLED'
        RETURNING old.health_state AS before_state`,
      [courierAccountId, shopId, to],
    );
    if (res.rowCount === 0) return false;
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'courier_account.health_transition',
      objectType: 'courier_account',
      objectId: courierAccountId,
      before: { healthState: res.rows[0].before_state },
      after: { healthState: to },
      reason,
    });
    return true;
  }
}
