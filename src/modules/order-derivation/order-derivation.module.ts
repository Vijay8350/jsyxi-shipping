import { Module, forwardRef } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { TrackPageModule } from '../track-page/track-page.module';
import { HealthModule } from '../health/health.module';
import { OrderDerivationService } from './order-derivation.service';
import { PrivacyRedactionService } from './privacy-redaction.service';
import {
  CustomersDataRequestHandler,
  CustomersRedactHandler,
  ShopRedactHandler,
} from './handlers/gdpr-webhook.handlers';

/**
 * Week-4 order derivation (§9.2.2, §9.2.4) + §5.5 privacy redaction.
 * DatabaseModule / AuditModule are global; ShopifyModule supplies the webhook
 * dispatcher the GDPR handlers register on (§8.1). The parent wires this
 * module into AppModule and calls
 * OrderDerivationService.evaluateAfterUpsert(result) from the order-sync
 * ingest flow (see the week-4 handoff).
 *
 * OrderDerivationService is exported for order-sync; PrivacyRedactionService
 * for the future notifications module (customers/data_request delivery).
 */
@Module({
  imports: [ShopifyModule, TrackPageModule, forwardRef(() => HealthModule)],
  providers: [
    OrderDerivationService,
    PrivacyRedactionService,
    CustomersRedactHandler,
    ShopRedactHandler,
    CustomersDataRequestHandler,
  ],
  exports: [OrderDerivationService, PrivacyRedactionService],
})
export class OrderDerivationModule {}
