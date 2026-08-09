import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { hmacSha256Hex, randomToken, tokenHash } from '../../common/crypto';
import { PG_POOL } from '../../database/database.module';
import { AdapterCallerService, CourierAccountRow } from './adapter-caller.service';
import { AdapterRegistry } from './adapter-registry';
import { CourierHealthService } from './courier-health.service';
import { isTestEventCapable } from './test-event';
import { WebhookStatsService } from './webhook-stats.service';
import {
  blobColumnForMode,
  CourierAccountMode,
  CredentialsVaultService,
  MaskedCredentialField,
} from './vault.service';

/**
 * Merchant courier accounts (§9.3.3) + the ADD-18 webhook management
 * surface. Owner-only at the controller (local role check on
 * req.session.role); every mutation is audited (§12) with masked
 * before/after — never plaintext credentials (INV-18, §5.7 control 3).
 *
 * RW-20: the TEST and LIVE blobs are written independently — every write
 * targets exactly one blob column, so a mode switch never overwrites the
 * other set.
 */

export interface ConnectAccountInput {
  courierId: string;
  /** Defaults to TEST (§9.3.3: connect in test mode first). */
  mode?: CourierAccountMode;
  credentials: Record<string, unknown>;
}

export interface AccountView {
  courierAccountId: string;
  courierId: string;
  courierCode: string;
  courierName: string;
  mode: CourierAccountMode;
  healthState: string;
  lastEventReceivedAt: string | null;
  disabledAt: string | null;
  /** Masked display for the CURRENT mode's set (§5.7 control 3). */
  credentials: MaskedCredentialField[];
  webhookUrl: string;
  createdAt: string;
}

export interface WebhookManagementView {
  courierAccountId: string;
  courierCode: string;
  /** §8.5: {apiUrl}/hooks/{courierCode}/{webhook_url_token}. */
  webhookUrl: string;
  /** Masked: existence only, never the value (INV-18). */
  secretSet: boolean;
  healthState: string;
  lastEventReceivedAt: string | null;
  events24h: number;
  signatureFailures24h: number;
}

/** Masked fingerprint for audit before/after — a token hash prefix, never
 *  the token itself (§12 + INV-18). */
function fingerprint(value: string): string {
  return tokenHash(value).slice(0, 12);
}

@Injectable()
export class CourierAccountService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly vault: CredentialsVaultService,
    private readonly audit: AuditService,
    private readonly caller: AdapterCallerService,
    private readonly registry: AdapterRegistry,
    private readonly health: CourierHealthService,
    private readonly webhookStats: WebhookStatsService,
  ) {}

  private apiUrl(): string {
    return (this.config.get<string>('shopify.apiUrl') ?? '').replace(/\/$/, '');
  }

  webhookUrl(courierCode: string, urlToken: string): string {
    // §8.5: api.jsyxi.com/hooks/{courier}/{token}.
    return `${this.apiUrl()}/hooks/${courierCode.toLowerCase()}/${urlToken}`;
  }

  private async loadAccount(shopId: string, courierAccountId: string): Promise<CourierAccountRow> {
    return this.caller.loadAccount(shopId, courierAccountId);
  }

  /** §9.3.3: connect an account. Key-paste only at v1; OAuth (Amazon
   *  Shipping, §9.3.4) connects through its own flow. */
  async connectAccount(
    shopId: string,
    actorId: string,
    input: ConnectAccountInput,
  ): Promise<AccountView> {
    const courier = await this.pool.query(
      `SELECT courier_id, code, name, auth_pattern, is_active
         FROM courier WHERE courier_id = $1`,
      [input.courierId],
    );
    if (courier.rowCount === 0 || !courier.rows[0].is_active) {
      throw new NotFoundException('courier not found or inactive');
    }
    if (courier.rows[0].auth_pattern !== 'KEY_PASTE') {
      throw new BadRequestException('this courier connects via OAuth, not key paste');
    }

    const mode: CourierAccountMode = input.mode ?? 'TEST';
    const fields = await this.vault.fieldSchema(input.courierId);
    const clean = this.vault.validateCredentials(fields, input.credentials);
    const blob = this.vault.encrypt(clean);
    const blobCol = blobColumnForMode(mode); // RW-20: exactly one blob written
    const urlToken = randomToken(24);
    const webhookSecret = randomToken(32);

    let row;
    try {
      const res = await this.pool.query(
        `INSERT INTO courier_account
           (shop_id, courier_id, mode, ${blobCol}, webhook_url_token, webhook_secret_encrypted)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING courier_account_id, created_at`,
        [
          shopId,
          input.courierId,
          mode,
          blob,
          urlToken,
          this.vault.encrypt({ secret: webhookSecret }),
        ],
      );
      row = res.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('an account for this courier already exists');
      }
      throw err;
    }

    // §12: account create. Masked after-values only (INV-18).
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'courier_account.create',
      objectType: 'courier_account',
      objectId: row.courier_account_id,
      after: {
        courierCode: courier.rows[0].code,
        mode,
        fieldsSet: Object.keys(clean).sort(),
      },
    });

    return {
      courierAccountId: row.courier_account_id,
      courierId: input.courierId,
      courierCode: courier.rows[0].code,
      courierName: courier.rows[0].name,
      mode,
      healthState: 'UNVERIFIED',
      lastEventReceivedAt: null,
      disabledAt: null,
      credentials: this.vault.maskedDisplay(fields, blob),
      webhookUrl: this.webhookUrl(courier.rows[0].code, urlToken),
      createdAt: row.created_at,
    };
  }

  /** §9.3.3: the merchant's accounts with masked credential display. */
  async listAccounts(shopId: string): Promise<AccountView[]> {
    const res = await this.pool.query(
      `SELECT ca.courier_account_id, ca.courier_id, c.code AS courier_code,
              c.name AS courier_name, ca.mode, ca.credentials_test_encrypted,
              ca.credentials_live_encrypted, ca.health_state,
              ca.last_event_received_at, ca.disabled_at, ca.webhook_url_token,
              ca.created_at
         FROM courier_account ca
         JOIN courier c ON c.courier_id = ca.courier_id
        WHERE ca.shop_id = $1
        ORDER BY c.name`,
      [shopId],
    );
    const out: AccountView[] = [];
    for (const r of res.rows) {
      const fields = await this.vault.fieldSchema(r.courier_id);
      const blob: Buffer | null = r[blobColumnForMode(r.mode as CourierAccountMode)];
      out.push({
        courierAccountId: r.courier_account_id,
        courierId: r.courier_id,
        courierCode: r.courier_code,
        courierName: r.courier_name,
        mode: r.mode,
        healthState: r.health_state,
        lastEventReceivedAt: r.last_event_received_at,
        disabledAt: r.disabled_at,
        credentials: this.vault.maskedDisplay(fields, blob),
        webhookUrl: this.webhookUrl(r.courier_code, r.webhook_url_token),
        createdAt: r.created_at,
      });
    }
    return out;
  }

  /**
   * §9.3.3: a REAL test-connection call — a harmless required-interface
   * probe (lookupByReference with a probe reference, §8.2). Success moves
   * UNVERIFIED → HEALTHY (§3.21); an auth failure lands on DISCONNECTED via
   * the transport policy.
   */
  async testConnection(
    shopId: string,
    courierAccountId: string,
  ): Promise<{ healthState: string }> {
    await this.caller.call(shopId, courierAccountId, 'lookupByReference', (adapter) =>
      adapter.lookupByReference('__connection_probe__'),
    );
    await this.health.transition(
      courierAccountId,
      shopId,
      'HEALTHY',
      'test connection succeeded (§9.3.3)',
    );
    const account = await this.loadAccount(shopId, courierAccountId);
    return { healthState: account.health_state };
  }

  /** §9.3.3 + RW-20: switch mode. Only the mode column is written — the
   *  other mode's credential blob is never touched. Audited (§12). */
  async switchMode(
    shopId: string,
    actorId: string,
    courierAccountId: string,
    mode: CourierAccountMode,
  ): Promise<{ mode: CourierAccountMode }> {
    const account = await this.loadAccount(shopId, courierAccountId);
    if (account.disabled_at) throw new ForbiddenException('courier account is disabled');
    if (account.mode === mode) return { mode };
    const res = await this.pool.query(
      `UPDATE courier_account SET mode = $3
        WHERE courier_account_id = $1 AND shop_id = $2
        RETURNING courier_account_id`,
      [courierAccountId, shopId, mode],
    );
    if (res.rowCount === 0) throw new NotFoundException('courier account not found');
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'courier_account.mode_change',
      objectType: 'courier_account',
      objectId: courierAccountId,
      before: { mode: account.mode },
      after: { mode },
    });
    return { mode };
  }

  /**
   * §5.7 control 3: the replace action. Validates and re-encrypts the blob
   * for the account's CURRENT mode only (RW-20); bumps version so cached
   * adapter instances rebuild (INV-22 doubles as cache invalidation).
   * Audited with masked before/after (§12).
   */
  async replaceCredentials(
    shopId: string,
    actorId: string,
    courierAccountId: string,
    credentials: Record<string, unknown>,
  ): Promise<{ credentials: MaskedCredentialField[] }> {
    const account = await this.loadAccount(shopId, courierAccountId);
    if (account.disabled_at) throw new ForbiddenException('courier account is disabled');
    const fields = await this.vault.fieldSchema(account.courier_id);
    const clean = this.vault.validateCredentials(fields, credentials);
    const blob = this.vault.encrypt(clean);
    const blobCol = blobColumnForMode(account.mode); // RW-20
    const beforeMasked = this.vault.maskedDisplay(
      fields,
      account[blobColumnForMode(account.mode)],
    );
    await this.pool.query(
      `UPDATE courier_account
          SET ${blobCol} = $3, version = version + 1
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [courierAccountId, shopId, blob],
    );
    const afterMasked = this.vault.maskedDisplay(fields, blob);
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'courier_account.credential_replace',
      objectType: 'courier_account',
      objectId: courierAccountId,
      before: { mode: account.mode, fields: beforeMasked },
      after: { mode: account.mode, fields: afterMasked },
    });
    return { credentials: afterMasked };
  }

  /** §9.3.3 enable/disable. Disable sets DISABLED + disabled_at (§3.21);
   *  enable returns the account to UNVERIFIED so a fresh test-connection
   *  call re-earns HEALTHY. Audited (§12). */
  async setEnabled(
    shopId: string,
    actorId: string,
    courierAccountId: string,
    enabled: boolean,
  ): Promise<{ healthState: string; disabledAt: string | null }> {
    const account = await this.loadAccount(shopId, courierAccountId);
    const res = await this.pool.query(
      enabled
        ? `UPDATE courier_account
              SET disabled_at = NULL, health_state = 'UNVERIFIED'
            WHERE courier_account_id = $1 AND shop_id = $2 AND disabled_at IS NOT NULL
            RETURNING courier_account_id`
        : `UPDATE courier_account
              SET disabled_at = now(), health_state = 'DISABLED'
            WHERE courier_account_id = $1 AND shop_id = $2 AND disabled_at IS NULL
            RETURNING courier_account_id`,
      [courierAccountId, shopId],
    );
    if (res.rowCount === 0) {
      // Idempotent: already in the requested state.
      return { healthState: account.health_state, disabledAt: account.disabled_at };
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: enabled ? 'courier_account.enable' : 'courier_account.disable',
      objectType: 'courier_account',
      objectId: courierAccountId,
      before: { healthState: account.health_state, disabledAt: account.disabled_at },
      after: { healthState: enabled ? 'UNVERIFIED' : 'DISABLED' },
    });
    return {
      healthState: enabled ? 'UNVERIFIED' : 'DISABLED',
      disabledAt: enabled ? null : 'set',
    };
  }

  // ------------------------------------------------------------------
  // ADD-18 — webhook management surface
  // ------------------------------------------------------------------

  /** ADD-18: the webhook management view — URL with copy, masked secret,
   *  health strip (last event, 24h counts, §3.21 state). The last-20-
   *  payloads viewer belongs to the tracking module. */
  async getWebhookManagement(
    shopId: string,
    courierAccountId: string,
  ): Promise<WebhookManagementView> {
    const account = await this.loadAccount(shopId, courierAccountId);
    const { events24h, signatureFailures24h } = await this.webhookStats.last24h(
      courierAccountId,
    );
    return {
      courierAccountId,
      courierCode: account.courier_code,
      webhookUrl: this.webhookUrl(account.courier_code, account.webhook_url_token),
      secretSet: account.webhook_secret_encrypted !== null,
      healthState: account.health_state,
      lastEventReceivedAt: account.last_event_received_at,
      events24h,
      signatureFailures24h,
    };
  }

  /** ADD-18: regenerate the signing secret — a SEPARATE audited action from
   *  URL-token regeneration. Before/after are masked fingerprints (§12). */
  async regenerateSecret(
    shopId: string,
    actorId: string,
    courierAccountId: string,
  ): Promise<{ consequence: string }> {
    const account = await this.loadAccount(shopId, courierAccountId);
    const oldSecret = account.webhook_secret_encrypted
      ? (this.vault.decrypt(account.webhook_secret_encrypted) as { secret: string }).secret
      : null;
    const newSecret = randomToken(32);
    await this.pool.query(
      `UPDATE courier_account SET webhook_secret_encrypted = $3
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [courierAccountId, shopId, this.vault.encrypt({ secret: newSecret })],
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'courier_account.webhook_secret_regenerate',
      objectType: 'courier_account',
      objectId: courierAccountId,
      before: { secretFingerprint: oldSecret ? fingerprint(oldSecret) : null },
      after: { secretFingerprint: fingerprint(newSecret) },
    });
    return {
      consequence:
        'The old signing secret stops verifying immediately; update the secret in the courier panel.',
    };
  }

  /** ADD-18: regenerate the URL token — the old inbound URL stops working
   *  immediately. Separate audited action (§12). */
  async regenerateUrlToken(
    shopId: string,
    actorId: string,
    courierAccountId: string,
  ): Promise<{ webhookUrl: string; consequence: string }> {
    const account = await this.loadAccount(shopId, courierAccountId);
    const newToken = randomToken(24);
    await this.pool.query(
      `UPDATE courier_account SET webhook_url_token = $3
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [courierAccountId, shopId, newToken],
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'courier_account.webhook_url_regenerate',
      objectType: 'courier_account',
      objectId: courierAccountId,
      before: { urlTokenFingerprint: fingerprint(account.webhook_url_token) },
      after: { urlTokenFingerprint: fingerprint(newToken) },
    });
    return {
      webhookUrl: this.webhookUrl(account.courier_code, newToken),
      consequence:
        'The old webhook URL stops working immediately; paste the new URL in the courier panel.',
    };
  }

  /**
   * ADD-18: send test event — the adapter's fake event, signed with the
   * account's webhook secret and POSTed to the account's own webhook path,
   * proving the URL is live before the first real shipment.
   */
  async sendTestEvent(
    shopId: string,
    courierAccountId: string,
  ): Promise<{ delivered: boolean; status: number | null; webhookUrl: string }> {
    const account = await this.loadAccount(shopId, courierAccountId);
    if (!account.webhook_secret_encrypted) {
      throw new BadRequestException('no webhook secret set for this account');
    }
    const blob = account[blobColumnForMode(account.mode)];
    if (!blob) {
      throw new BadRequestException(`no ${account.mode} credentials set for this account`);
    }
    const adapter = this.registry.getAdapter({
      courierAccountId: account.courier_account_id,
      courierCode: account.courier_code,
      mode: account.mode,
      credentials: this.vault.decrypt(blob), // call-time only (INV-18)
      credentialsVersion: account.version,
      now: () => new Date(),
    });
    if (!isTestEventCapable(adapter)) {
      throw new BadRequestException(
        `courier '${account.courier_code}' cannot fabricate a test event`,
      );
    }
    const event = adapter.buildTestWebhookEvent();
    const { secret } = this.vault.decrypt(account.webhook_secret_encrypted) as {
      secret: string;
    };
    const body = JSON.stringify(event.payload);
    const url = this.webhookUrl(account.courier_code, account.webhook_url_token);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-jsyxi-signature': hmacSha256Hex(secret, body),
        },
        body,
        signal: controller.signal,
      });
      return { delivered: res.ok, status: res.status, webhookUrl: url };
    } catch {
      return { delivered: false, status: null, webhookUrl: url };
    } finally {
      clearTimeout(timeout);
    }
  }
}
