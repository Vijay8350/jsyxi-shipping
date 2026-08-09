import { Module } from '@nestjs/common';
import {
  CAPTCHA_VERIFIER,
  DevPassCaptchaVerifier,
} from './captcha-verifier';
import { OwnerGuard } from './owner.guard';
import { TrackPageConfigController } from './track-page-config.controller';
import { TrackPageConfigService } from './track-page-config.service';
import { TrackPageDataService } from './track-page-data.service';
import { TrackLookupService } from './track-lookup.service';
import { TrackPublicController } from './track-public.controller';
import { TrackTokenService } from './track-token.service';

/**
 * Track-Order page module (§9.16, §7.6, §2.8).
 *
 * DatabaseModule, RedisModule, AuthModule and AuditModule are @Global, so
 * PG_POOL, REDIS, SessionGuard and AuditService inject without imports.
 *
 * TrackTokenService is exported for the modules that issue and revoke links:
 * booking/sync-back issue at fulfillment time (ADD-26 sends them later), and
 * the uninstall/redaction paths call revokeAllForShop / revokeForShipment
 * (§5.5). The default CAPTCHA verifier is dev-pass; the production provider
 * binds CAPTCHA_VERIFIER to a real implementation (S-38).
 */
@Module({
  controllers: [TrackPageConfigController, TrackPublicController],
  providers: [
    TrackPageConfigService,
    TrackPageDataService,
    TrackTokenService,
    TrackLookupService,
    OwnerGuard,
    { provide: CAPTCHA_VERIFIER, useClass: DevPassCaptchaVerifier },
  ],
  exports: [TrackTokenService, TrackPageConfigService],
})
export class TrackPageModule {}
