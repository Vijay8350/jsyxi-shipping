import { Controller, Headers, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ShopifyWebhookIngestService } from './webhook-ingest.service';

/**
 * §8.1: POST /webhooks/shopify — the stateless ingest tier. HMAC is computed
 * over the RAW body, so this route needs raw-body access: main.ts must be
 * created with `rawBody: true` (Nest populates req.rawBody for all routes
 * then). Without it the ingest service fails closed with 500.
 */
@Controller('webhooks')
export class ShopifyWebhookController {
  constructor(private readonly ingest: ShopifyWebhookIngestService) {}

  @Post('shopify')
  async shopify(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-shopify-hmac-sha256') hmac: string | undefined,
    @Headers('x-shopify-shop-domain') shopDomain: string | undefined,
    @Headers('x-shopify-topic') topic: string | undefined,
    @Headers('x-shopify-webhook-id') webhookId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object> {
    const rawBody =
      req.rawBody ?? (Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined);
    const result = await this.ingest.ingest({
      rawBody,
      hmacHeader: hmac,
      shopDomain,
      topic,
      webhookId,
    });
    res.status(result.status);
    return result.body;
  }
}
