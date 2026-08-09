import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ShopifyOAuthError, ShopifyOAuthService } from './oauth.service';

/** §9.1.1: OAuth install flow endpoints. */
@Controller('shopify')
export class ShopifyOAuthController {
  constructor(
    private readonly oauth: ShopifyOAuthService,
    private readonly config: ConfigService,
  ) {}

  @Get('install')
  async install(@Query('shop') shop: string | undefined, @Res() res: Response): Promise<void> {
    try {
      const url = await this.oauth.beginInstall(shop);
      res.redirect(url);
    } catch (err) {
      this.respondError(res, err);
    }
  }

  @Get('callback')
  async callback(
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { entryToken } = await this.oauth.handleCallback(query);
      // §9.1.1, §5.7 control 6: the signed, short-lived entry token is handed
      // to the app surface, which exchanges it at POST /auth/shopify-entry.
      const appUrl = this.config.get<string>('shopify.appUrl') ?? '';
      res.redirect(`${appUrl}/entry?token=${encodeURIComponent(entryToken)}`);
    } catch (err) {
      this.respondError(res, err);
    }
  }

  private respondError(res: Response, err: unknown): void {
    if (err instanceof ShopifyOAuthError) {
      res.status(statusFor(err.code)).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
}

function statusFor(code: ShopifyOAuthError['code']): number {
  switch (code) {
    case 'INVALID_SHOP_DOMAIN':
    case 'BAD_STATE':
    case 'CURRENCY_NOT_INR':
      return 400;
    case 'BAD_HMAC':
      return 401;
    case 'STAFF_IDENTITY_UNAVAILABLE':
      return 403;
    default:
      return 502;
  }
}
