import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-keys/api-key.controller';
import { ApiKeyGuard } from './api-keys/api-key.guard';
import { ApiKeyService } from './api-keys/api-key.service';
import { I18nService } from './i18n/i18n.service';
import { EntitlementLedgerService } from './ledger/entitlement-ledger.service';
import { StoreSettingsController } from './settings/store-settings.controller';
import { StoreSettingsService } from './settings/store-settings.service';

/**
 * Platform module: store general settings (§7.1, §9.20), the i18n scaffold
 * (§9.20), the AWB entitlement ledger writer (INV-12, §9.5.6) and the
 * merchant API key model (ADD-20). Database, auth and audit modules are
 * global, so no imports are needed here.
 */
@Module({
  controllers: [StoreSettingsController, ApiKeyController],
  providers: [
    StoreSettingsService,
    I18nService,
    EntitlementLedgerService,
    ApiKeyService,
    ApiKeyGuard,
  ],
  exports: [
    StoreSettingsService,
    I18nService,
    EntitlementLedgerService,
    ApiKeyService,
    ApiKeyGuard,
  ],
})
export class PlatformModule {}
