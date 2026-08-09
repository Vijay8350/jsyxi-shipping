import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { TrackLookupDto } from './track-page.dto';
import { TrackLookupService } from './track-lookup.service';
import { TrackPageConfigService } from './track-page-config.service';
import { TrackPageDataService } from './track-page-data.service';
import { TrackTokenService } from './track-token.service';
import { TRACK_PAGE_CONFIG_DEFAULTS } from './track-page.types';
import { renderLookupShell, renderTokenShell } from './track-page.templates';

/**
 * Public Track-Order page endpoints (§9.16) — NO session, by design.
 *
 * API-first: every render endpoint also answers `Accept: application/json`
 * with the JSON contract (track-page.types.ts) the hosted frontend renders;
 * the inline HTML shell is a deliberately thin stopgap (§9.22's design
 * system lands with the frontend).
 *
 * Failure surface is uniform: an invalid/revoked token or unknown shopRef is
 * a 404 with the same wording — never a hint about which part was wrong.
 */
@Controller('track')
export class TrackPublicController {
  constructor(
    private readonly tokens: TrackTokenService,
    private readonly lookup: TrackLookupService,
    private readonly pageConfig: TrackPageConfigService,
    private readonly pageData: TrackPageDataService,
  ) {}

  private static wantsJson(req: Request): boolean {
    return (req.headers.accept ?? '').includes('application/json');
  }

  /** Path 1 (A1-07, A2-12): the tokenized per-shipment link. */
  @Get('t/:token')
  async tokenPage(
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const resolved = await this.tokens.resolve(token);
    if (!resolved) {
      // Unknown, revoked (§5.5) or uninstalled shop (§9.16) — one answer.
      res.status(404);
      if (TrackPublicController.wantsJson(req)) {
        return { ok: false, error: 'This tracking link is no longer valid.' };
      }
      res.type('html');
      return renderTokenShell(
        { ...TRACK_PAGE_CONFIG_DEFAULTS },
        null,
        'This tracking link is no longer valid.',
      );
    }

    const { shipment } = resolved;
    const config = await this.pageConfig.getForRender(shipment.shop_id);
    const branding = this.pageData.branding(config);
    const data = this.pageData.buildShipmentData(
      shipment,
      await this.pageData.loadTimeline(shipment.shop_id, shipment.shipment_id),
      config,
    );

    if (TrackPublicController.wantsJson(req)) {
      return { ok: true, branding, shipment: data };
    }
    res.type('html');
    return renderTokenShell(branding, data);
  }

  /** Hosted lookup page — the S-31/S-32 form for path 2. */
  @Get(':shopRef')
  async lookupPage(
    @Param('shopRef') shopRef: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const shopId = /^[0-9a-f]{12}$/.test(shopRef)
      ? await this.lookup.resolveShopRef(shopRef)
      : null;
    if (!shopId) {
      res.status(404);
      if (TrackPublicController.wantsJson(req)) {
        return { ok: false, error: 'This tracking page is no longer available.' };
      }
      res.type('html');
      return renderLookupShell(
        shopRef,
        { ...TRACK_PAGE_CONFIG_DEFAULTS },
        'This tracking page is no longer available.',
      );
    }

    const config = await this.pageConfig.getForRender(shopId);
    const branding = this.pageData.branding(config);
    if (TrackPublicController.wantsJson(req)) {
      return { ok: true, shopRef, branding };
    }
    res.type('html');
    return renderLookupShell(shopRef, branding);
  }

  /**
   * Path 2 (§9.16): manual lookup. One generic failure for every failure
   * mode; S-38 throttling and CAPTCHA escalation inside the service.
   */
  @Post('lookup')
  lookupPost(@Body() dto: TrackLookupDto, @Ip() ip: string) {
    return this.lookup.lookup(dto, ip);
  }
}
