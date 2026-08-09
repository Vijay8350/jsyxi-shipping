import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  NdrAlertChannel,
  NdrDigestFrequency,
  NdrSettingsRow,
} from './ndr.types';

export const NDR_SETTINGS_DEFAULTS: Omit<NdrSettingsRow, 'shop_id' | 'version'> = {
  recipients: [], // S-41 default: the Owner's email — resolved by the caller's UI
  channel: 'email', // S-42
  digest_frequency: 'daily', // S-42
  auto_reattempt_once: false, // S-43
  escalation_templates: [],
};

const FREQUENCIES: readonly NdrDigestFrequency[] = ['hourly', 'daily', 'weekly'];
const CHANNELS: readonly NdrAlertChannel[] = ['email', 'sms', 'whatsapp'];

/**
 * §9.8.2 NDR settings (A4-02: per Shop, not per warehouse): S-41 recipients,
 * S-42 channel + digest frequency, S-43 auto-reattempt-once, escalation note
 * templates. Operator+ only (§10.2 'settings.ndr_notifications.edit').
 * Settings changes are audited (§12: every S-value).
 */
@Injectable()
export class NdrSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** Read with defaults when the shop has no row yet (S-41–S-43 defaults). */
  async get(shopId: string): Promise<NdrSettingsRow> {
    const res = await this.pool.query<NdrSettingsRow>(
      `SELECT shop_id, recipients, channel, digest_frequency,
              auto_reattempt_once, escalation_templates, version
         FROM ndr_settings WHERE shop_id = $1`,
      [shopId],
    );
    return res.rows[0] ?? { shop_id: shopId, version: 0, ...NDR_SETTINGS_DEFAULTS };
  }

  async update(
    shopId: string,
    patch: {
      recipients?: string[];
      channel?: NdrAlertChannel;
      digestFrequency?: NdrDigestFrequency;
      autoReattemptOnce?: boolean;
      escalationTemplates?: unknown[];
    },
    actorMemberId: string,
  ): Promise<NdrSettingsRow> {
    if (patch.digestFrequency && !FREQUENCIES.includes(patch.digestFrequency)) {
      throw new Error(`invalid digest_frequency (S-42): ${patch.digestFrequency}`);
    }
    if (patch.channel && !CHANNELS.includes(patch.channel)) {
      throw new Error(`invalid channel (S-42): ${patch.channel}`);
    }
    const before = await this.get(shopId);
    const res = await this.pool.query<NdrSettingsRow>(
      `INSERT INTO ndr_settings
         (shop_id, recipients, channel, digest_frequency,
          auto_reattempt_once, escalation_templates)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (shop_id) DO UPDATE SET
         recipients = EXCLUDED.recipients,
         channel = EXCLUDED.channel,
         digest_frequency = EXCLUDED.digest_frequency,
         auto_reattempt_once = EXCLUDED.auto_reattempt_once,
         escalation_templates = EXCLUDED.escalation_templates,
         version = ndr_settings.version + 1
       RETURNING shop_id, recipients, channel, digest_frequency,
                 auto_reattempt_once, escalation_templates, version`,
      [
        shopId,
        JSON.stringify(patch.recipients ?? before.recipients),
        patch.channel ?? before.channel,
        patch.digestFrequency ?? before.digest_frequency,
        patch.autoReattemptOnce ?? before.auto_reattempt_once,
        JSON.stringify(patch.escalationTemplates ?? before.escalation_templates),
      ],
    );
    const after = res.rows[0];
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actorMemberId,
      action: 'ndr_settings.update', // §12: settings changes (S-41–S-43)
      objectType: 'ndr_settings',
      objectId: shopId,
      before,
      after,
    });
    return after;
  }
}
