import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module';
import { AuditService } from '../../../audit/audit.service';
import { SessionService } from '../../../auth/session.service';
import { TrackTokenService } from '../../track-page/track-token.service';
import {
  ShopifyWebhookDispatcher,
  ShopifyWebhookHandler,
  ShopifyWebhookMessage,
} from '../webhook-dispatcher.service';

/**
 * §5.5 / §9.1.5: app/uninstalled. Immediate and irreversible:
 *  - account_state → UNINSTALLED, uninstalled_at = now()
 *  - the Shopify credential is DESTROYED (no other state destroys one — §5.5)
 *  - every session of the shop is invalidated (§9.1.4)
 *  - audited (§12: uninstall is always audited)
 *
 * Reinstall is a fresh connection: the OAuth upsert resets the cycle, never
 * restores this one.
 */
@Injectable()
export class AppUninstalledHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'app/uninstalled';

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly trackTokens: TrackTokenService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    // Guard on current state so a replayed handler run is a no-op.
    await this.pool.query(
      `UPDATE shop
          SET account_state = 'UNINSTALLED',
              uninstalled_at = now(),
              shopify_access_token_encrypted = NULL,
              version = version + 1
        WHERE shop_id = $1 AND account_state <> 'UNINSTALLED'`,
      [message.shopId],
    );
    await this.sessions.invalidateShop(message.shopId, 'UNINSTALL');
    // §5.5: uninstall invalidates all public track tokens too.
    await this.trackTokens.revokeAllForShop(message.shopId);
    await this.audit.record({
      shopId: message.shopId,
      actorKind: 'SYSTEM',
      action: 'SHOP_UNINSTALLED',
      objectType: 'shop',
      objectId: message.shopId,
      after: { account_state: 'UNINSTALLED' },
      reason: 'app/uninstalled webhook (§5.5, §9.1.5)',
    });
  }
}
