import {
  Controller,
  forwardRef,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { Request, Response } from 'express';
import { hmacSha256Hex, safeEqualHex } from '../../common/crypto';
import { EnvelopeCipher } from '../../common/envelope';
import { PG_POOL } from '../../database/database.module';
import { WebhookStatsService } from './webhook-stats.service';
import { CourierWebhookIngestService } from '../tracking/courier-webhook-ingest.service';

/**
 * §8.5 inbound courier webhooks: POST /hooks/{courierCode}/{token}.
 *
 * This is the minimal live ingest tier the ADD-18 surface manages: resolve
 * the account by its URL token, verify the HMAC signature against the
 * account's envelope-encrypted signing secret, update the health strip
 * (last_event_received_at + 24h counters), and acknowledge. Durable
 * webhook_inbox persistence (RECEIVED, §3.26), dedupe and normalization
 * against courier_status_map (§3.6) belong to the tracking module (§9.7).
 *
 * No SessionGuard — this path is called by couriers, authenticated by the
 * per-account URL token + HMAC signature (§8.5). Failures fail closed.
 */
@Controller('hooks')
export class CourierWebhookController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly stats: WebhookStatsService,
    @Inject(forwardRef(() => CourierWebhookIngestService))
    private readonly ingest: CourierWebhookIngestService,
  ) {}

  @Post(':courierCode/:token')
  @HttpCode(200)
  async receive(
    @Param('courierCode') courierCode: string,
    @Param('token') token: string,
    @Headers('x-jsyxi-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object> {
    const account = await this.pool.query(
      `SELECT ca.courier_account_id, ca.shop_id, ca.webhook_secret_encrypted,
              c.code AS courier_code
         FROM courier_account ca
         JOIN courier c ON c.courier_id = ca.courier_id
        WHERE ca.webhook_url_token = $1`,
      [token],
    );
    // The token is an unguessable capability (§8.5); an unknown token or a
    // courier/path mismatch gets the same flat 401 — no oracle.
    if (account.rowCount === 0) throw new UnauthorizedException('unknown webhook');
    const row = account.rows[0];
    if (row.courier_code.toLowerCase() !== courierCode.toLowerCase()) {
      throw new UnauthorizedException('unknown webhook');
    }
    if (!row.webhook_secret_encrypted) throw new UnauthorizedException('webhook not configured');

    // rawBody: the HMAC is computed over the raw request body (main.ts
    // rawBody: true). Without it we fail closed.
    const rawBody =
      req.rawBody ?? (Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined);
    if (!rawBody || !signature) throw new UnauthorizedException('invalid signature');

    const secret = JSON.parse(
      EnvelopeCipher.fromHex(this.config.get<string>('crypto.masterKeyHex') ?? '')
        .decrypt(row.webhook_secret_encrypted as Buffer)
        .toString('utf8'),
    ) as { secret: string };
    const expected = hmacSha256Hex(secret.secret, rawBody);
    if (!safeEqualHex(expected, signature)) {
      await this.stats.recordSignatureFailure(row.courier_account_id);
      // ADD-18: failed signatures land as SIGNATURE_FAILURE rows in the
      // last-20-payloads viewer. Still rejected and never processed (§8.5).
      await this.ingest.ingestVerifiedWebhook({
        courierAccountId: row.courier_account_id,
        courierCode: row.courier_code,
        shopId: row.shop_id,
        rawBody,
        signatureValid: false,
      });
      throw new UnauthorizedException('invalid signature');
    }

    // §8.5 health: "last event received" drives the ADD-18 strip and
    // COURIER_ACCOUNT_HEALTH (§3.21).
    await this.pool.query(
      `UPDATE courier_account SET last_event_received_at = now()
        WHERE courier_account_id = $1`,
      [row.courier_account_id],
    );
    await this.stats.recordEventReceived(row.courier_account_id);
    // §8.5: the raw payload is persisted durably BEFORE the <100ms ack;
    // normalization is asynchronous (§3.26 RECEIVED semantics).
    await this.ingest.ingestVerifiedWebhook({
      courierAccountId: row.courier_account_id,
      courierCode: row.courier_code,
      shopId: row.shop_id,
      rawBody,
      signatureValid: true,
    });
    res.status(200);
    return { received: true };
  }
}
