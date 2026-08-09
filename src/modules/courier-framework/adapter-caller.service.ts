import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AdapterRegistry } from './adapter-registry';
import { AdapterMethod, CourierAdapter } from './adapter.types';
import { CallPriority } from './adapter-errors';
import { TransportPolicy } from './transport-policy';
import { blobColumnForMode, CourierAccountMode, CredentialsVaultService } from './vault.service';

/**
 * The adapter-call path (§8.2 transport policy). The ONLY place plaintext
 * credentials are decrypted (§5.7 control 1, INV-18): at call time, inside
 * this service, handed straight to the adapter build. Every call passes
 * through the per-account rate limiter and circuit breaker, and every
 * outcome routes through the §3.21 health transitions.
 */

export interface CourierAccountRow {
  courier_account_id: string;
  shop_id: string;
  courier_id: string;
  courier_code: string;
  mode: CourierAccountMode;
  credentials_test_encrypted: Buffer | null;
  credentials_live_encrypted: Buffer | null;
  health_state: string;
  disabled_at: string | null;
  webhook_url_token: string;
  webhook_secret_encrypted: Buffer | null;
  last_event_received_at: string | null;
  version: number;
}

const ACCOUNT_SELECT = `
  SELECT ca.courier_account_id, ca.shop_id, ca.courier_id, c.code AS courier_code,
         ca.mode, ca.credentials_test_encrypted, ca.credentials_live_encrypted,
         ca.health_state, ca.disabled_at, ca.webhook_url_token,
         ca.webhook_secret_encrypted, ca.last_event_received_at, ca.version
    FROM courier_account ca
    JOIN courier c ON c.courier_id = ca.courier_id
   WHERE ca.courier_account_id = $1 AND ca.shop_id = $2`;

@Injectable()
export class AdapterCallerService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly vault: CredentialsVaultService,
    private readonly registry: AdapterRegistry,
    private readonly policy: TransportPolicy,
  ) {}

  /** Shop-scoped account load (INV-1). */
  async loadAccount(shopId: string, courierAccountId: string): Promise<CourierAccountRow> {
    const res = await this.pool.query(ACCOUNT_SELECT, [courierAccountId, shopId]);
    if (res.rowCount === 0) throw new NotFoundException('courier account not found');
    return res.rows[0] as CourierAccountRow;
  }

  /**
   * Run one adapter method under the full transport policy.
   * `method` decides the S-17 priority (quotes lower than everything else).
   */
  async call<T>(
    shopId: string,
    courierAccountId: string,
    method: AdapterMethod,
    invoke: (adapter: CourierAdapter) => Promise<T>,
  ): Promise<T> {
    const account = await this.loadAccount(shopId, courierAccountId);
    if (account.disabled_at) {
      throw new ForbiddenException('courier account is disabled');
    }
    const blob = account[blobColumnForMode(account.mode)];
    if (!blob) {
      // INV-7: valid credentials for the account's current mode are a
      // booking hard-block; surfaced here for every call, not just booking.
      throw new BadRequestException(
        `no ${account.mode} credentials set for this courier account`,
      );
    }

    const priority: CallPriority = method === 'getQuote' ? 'QUOTE' : 'BOOKING';
    // Fail fast on an open breaker, then consume budget (S-17).
    await this.policy.beforeCall(account.courier_account_id);
    await this.policy.consumeBudget(account.courier_account_id, priority);

    // §5.7 control 1: decrypt at call time, only here.
    const credentials = this.vault.decrypt(blob);
    const adapter = this.registry.getAdapter({
      courierAccountId: account.courier_account_id,
      courierCode: account.courier_code,
      mode: account.mode,
      credentials,
      credentialsVersion: account.version,
      now: () => new Date(),
    });

    try {
      const result = await invoke(adapter);
      await this.policy.afterSuccess(account.courier_account_id, shopId);
      return result;
    } catch (err) {
      await this.policy.afterFailure(account.courier_account_id, shopId, err);
      throw err;
    }
  }
}
