import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { SESSION_COOKIE } from '../../auth/session.types';
import { EntryTokenError } from './entry-token.service';
import { ShopifyEntryService } from './entry.service';

/**
 * §9.1.1: exchange a signed Shopify-entry token for an app session, set as
 * the `jsyxi_session` cookie. NO_ACCESS is a distinct 403 response — the
 * caller surfaces "No access" plus the request-access affordance (§9.1.2).
 */
@Controller('auth')
export class ShopifyEntryController {
  constructor(
    private readonly entry: ShopifyEntryService,
    private readonly config: ConfigService,
  ) {}

  @Post('shopify-entry')
  @HttpCode(200)
  async shopifyEntry(
    @Body() body: { token?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object> {
    if (!body || typeof body.token !== 'string' || body.token.length === 0) {
      throw new BadRequestException({ status: 'TOKEN_REQUIRED' });
    }
    let result;
    try {
      result = await this.entry.exchange(body.token, req.ip ?? null);
    } catch (err) {
      if (err instanceof EntryTokenError) {
        throw new UnauthorizedException({ status: 'ENTRY_TOKEN_INVALID', code: err.code });
      }
      throw err;
    }
    if (result.status === 'NO_ACCESS') {
      res.status(403);
      return result;
    }
    // RW-04: cookie lifetime matches the session TTL. httpOnly + secure per
    // §5.7 control 2 (TLS on every surface).
    const ttlSeconds = this.config.get<number>('session.ttlSeconds') ?? 43200;
    res.cookie(SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ttlSeconds * 1000,
    });
    return { status: 'OK' };
  }
}
