import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { COD_CONFIRM_DEFAULT_WINDOW_MINUTES } from './notifications.types';

/**
 * notification_settings (migration 0014): S-45 per-event toggles, ADD-25
 * per-event channel selection, and the §9.21 hard-bounce suppression list.
 * All reads are shop-scoped (INV-1). Missing row = spec defaults (S-45:
 * every operational alert ON).
 *
 * channel_selection jsonb shapes (kept flat, documented here as the only
 * reader/writer):
 *   buyerEvents: { [buyerEvent]: { EMAIL?: boolean, SMS?: boolean, WHATSAPP?: boolean } }
 *   codConfirmation: { windowMinutes?: number, onExpiry?: 'BOOK_ANYWAY' | 'HOLD' }
 *   digestHourLocal?: number  (default 9 — shop-local, §5.2)
 */

export interface NotificationSettingsRow {
  event_toggles: Record<string, boolean>;
  channel_selection: Record<string, unknown>;
  suppressed_addresses: string[];
}

export type CodExpiryPolicy = 'BOOK_ANYWAY' | 'HOLD';

@Injectable()
export class NotificationSettingsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private async row(shopId: string): Promise<NotificationSettingsRow> {
    const result = await this.pool.query<NotificationSettingsRow>(
      `SELECT event_toggles, channel_selection, suppressed_addresses
         FROM notification_settings WHERE shop_id = $1`,
      [shopId],
    );
    return (
      result.rows[0] ?? {
        event_toggles: {},
        channel_selection: {},
        suppressed_addresses: [],
      }
    );
  }

  /** S-45: default is ON for every operational alert. */
  async isEventEnabled(shopId: string, event: string): Promise<boolean> {
    const settings = await this.row(shopId);
    return settings.event_toggles[event] !== false;
  }

  async setEventToggle(
    shopId: string,
    event: string,
    enabled: boolean,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_settings (shop_id, event_toggles)
       VALUES ($1, jsonb_build_object($2::text, $3::boolean))
       ON CONFLICT (shop_id) DO UPDATE
         SET event_toggles = notification_settings.event_toggles
               || jsonb_build_object($2::text, $3::boolean)`,
      [shopId, event, enabled],
    );
  }

  async getChannelSelection(shopId: string): Promise<Record<string, unknown>> {
    return (await this.row(shopId)).channel_selection;
  }

  /** S-45: the raw toggle map (absent key = default ON). */
  async getEventToggles(shopId: string): Promise<Record<string, boolean>> {
    return (await this.row(shopId)).event_toggles;
  }

  async putChannelSelection(
    shopId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_settings (shop_id, channel_selection)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (shop_id) DO UPDATE
         SET channel_selection = notification_settings.channel_selection || $2::jsonb`,
      [shopId, JSON.stringify(patch)],
    );
  }

  /** ADD-28: the per-shop confirmation window (default 60 minutes). */
  async codConfirmationWindowMinutes(shopId: string): Promise<number> {
    const sel = await this.getChannelSelection(shopId);
    const cod = sel['codConfirmation'] as
      | { windowMinutes?: number }
      | undefined;
    return cod?.windowMinutes ?? COD_CONFIRM_DEFAULT_WINDOW_MINUTES;
  }

  /** ADD-28: what the sweep does on expiry — default book anyway. */
  async codConfirmationExpiryPolicy(shopId: string): Promise<CodExpiryPolicy> {
    const sel = await this.getChannelSelection(shopId);
    const cod = sel['codConfirmation'] as
      | { onExpiry?: CodExpiryPolicy }
      | undefined;
    return cod?.onExpiry === 'HOLD' ? 'HOLD' : 'BOOK_ANYWAY';
  }

  /** ADD-26: per-event on/off per channel. Default: EMAIL on, SMS/WHATSAPP
   *  off (both need approved templates and configured providers anyway). */
  async buyerChannels(
    shopId: string,
    event: string,
  ): Promise<Record<'EMAIL' | 'SMS' | 'WHATSAPP', boolean>> {
    const sel = await this.getChannelSelection(shopId);
    const perEvent =
      (sel['buyerEvents'] as Record<string, Record<string, boolean>> | undefined)?.[
        event
      ] ?? {};
    return {
      EMAIL: perEvent['EMAIL'] ?? true,
      SMS: perEvent['SMS'] ?? false,
      WHATSAPP: perEvent['WHATSAPP'] ?? false,
    };
  }

  async digestHourLocal(shopId: string): Promise<number> {
    const sel = await this.getChannelSelection(shopId);
    const hour = sel['digestHourLocal'];
    return typeof hour === 'number' && hour >= 0 && hour <= 23
      ? hour
      : 9; // DEFAULT_DIGEST_HOUR_LOCAL — kept literal to avoid a circular import
  }

  /** §9.21: hard-bounce suppression. Stores salted hashes, never raw
   *  addresses (§5.7 control 4). */
  async isSuppressed(shopId: string, addressHash: string): Promise<boolean> {
    const settings = await this.row(shopId);
    return settings.suppressed_addresses.includes(addressHash);
  }

  async suppressAddress(shopId: string, addressHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_settings (shop_id, suppressed_addresses)
       VALUES ($1, jsonb_build_array($2::text))
       ON CONFLICT (shop_id) DO UPDATE
         SET suppressed_addresses =
               notification_settings.suppressed_addresses || to_jsonb($2::text)
         WHERE NOT notification_settings.suppressed_addresses @> to_jsonb($2::text)`,
      [shopId, addressHash],
    );
  }
}
