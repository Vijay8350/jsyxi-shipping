import { Module, forwardRef } from '@nestjs/common';
import { TrackingModule } from '../tracking/tracking.module';
import { AdapterCallerService } from './adapter-caller.service';
import { AdapterFactory, AdapterRegistry, ADAPTER_FACTORIES } from './adapter-registry';
import { CourierAccountController } from './courier-account.controller';
import { CourierAccountService } from './courier-account.service';
import { CourierCatalogService } from './courier-catalog.service';
import { CourierHealthService } from './courier-health.service';
import { CourierRequestService } from './courier-request.service';
import { CourierWebhookController } from './courier-webhook.controller';
import { FakeCourierAdapter } from './fake/fake-courier-adapter';
import { MerchantServicesService } from './merchant-services.service';
import { OwnerGuard } from './owner.guard';
import { TransportPolicy } from './transport-policy';
import { CredentialsVaultService } from './vault.service';
import { WebhookStatsService } from './webhook-stats.service';

/**
 * Courier framework (§9.3): the credential vault (§5.7 controls 1 & 3,
 * RW-20), the adapter registry + transport policy (§8.2, S-17), courier
 * account management with the ADD-18 webhook surface, merchant services
 * (§9.3.2) and the §15.1 deterministic fake adapter.
 *
 * Real launch adapters (§9.3.4 — Delhivery, Xpressbees, …) register their
 * factories through the ADAPTER_FACTORIES token from their own modules.
 */
const FAKE_FACTORIES: Record<string, AdapterFactory> = {
  FAKE: (ctx) =>
    new FakeCourierAdapter({ courierCode: ctx.courierCode }, ctx.now),
};

@Module({
  // forwardRef: TrackingModule imports this module for AdapterCallerService;
  // the webhook controller needs the tracking module's durable ingest (§8.5).
  imports: [forwardRef(() => TrackingModule)],
  controllers: [CourierAccountController, CourierWebhookController],
  providers: [
    { provide: ADAPTER_FACTORIES, useValue: FAKE_FACTORIES },
    AdapterRegistry,
    AdapterCallerService,
    CredentialsVaultService,
    TransportPolicy,
    CourierHealthService,
    CourierCatalogService,
    CourierAccountService,
    MerchantServicesService,
    CourierRequestService,
    WebhookStatsService,
    OwnerGuard,
  ],
  exports: [
    AdapterRegistry,
    AdapterCallerService,
    CredentialsVaultService,
    TransportPolicy,
    CourierHealthService,
    CourierCatalogService,
    CourierAccountService,
    MerchantServicesService,
    ADAPTER_FACTORIES,
  ],
})
export class CourierFrameworkModule {}
