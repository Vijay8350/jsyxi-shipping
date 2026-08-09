import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../../auth/session.guard';
import { OwnerGuard } from './owner.guard';
import { UpdateTrackPageConfigDto } from './track-page.dto';
import { TrackPageConfigService } from './track-page-config.service';
import { TrackPageDataService } from './track-page-data.service';
import { renderSnippet } from './track-page.templates';

/**
 * Merchant-side track-page endpoints (§9.16). SessionGuard establishes the
 * (shop_id, member_id) session (INV-1); OwnerGuard enforces §7.6's
 * "Changed by: Owner" for S-31–S-37 and S-49 (local role check, §10.2).
 */
@Controller('track-page')
@UseGuards(SessionGuard, OwnerGuard)
export class TrackPageConfigController {
  constructor(
    private readonly configService: TrackPageConfigService,
    private readonly pageData: TrackPageDataService,
  ) {}

  /** Current config; first read creates the row with §7.6 defaults. */
  @Get('config')
  getConfig(@Req() req: AuthenticatedRequest) {
    return this.configService.getOrCreate(req.session.shopId);
  }

  /** INV-22 version-checked patch; every change audited (§12). */
  @Patch('config')
  updateConfig(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateTrackPageConfigDto,
  ) {
    return this.configService.update(req.session.shopId, dto, {
      memberId: req.session.memberId,
    });
  }

  /**
   * "Generate code" (§9.16): the embeddable snippet the merchant pastes as
   * a Shopify store page. The form points at the hosted page
   * `{appUrl}/track/{shopPublicRef}` — never the internal shop_id.
   */
  @Get('snippet')
  async getSnippet(@Req() req: AuthenticatedRequest) {
    const shopId = req.session.shopId;
    const config = await this.configService.getOrCreate(shopId);
    const shopRef = this.configService.publicRef(shopId);
    const hostedPageUrl = this.configService.hostedPageUrl(shopId);
    return {
      shopRef,
      hostedPageUrl,
      html: renderSnippet(
        shopRef,
        hostedPageUrl,
        this.pageData.branding(config),
      ),
    };
  }
}
