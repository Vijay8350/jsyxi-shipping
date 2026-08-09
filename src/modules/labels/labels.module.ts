import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { DocumentUrlSigner } from '../booking-ops/document-urls';
import { LocalFilesystemObjectStore, OBJECT_STORE } from '../booking-ops/object-store';
import { LabelsController } from './labels.controller';
import { ShipmentLabelsController } from './shipment-labels.controller';
import { LabelTemplateService } from './label-template.service';
import { LabelsService } from './labels.service';
import { BulkLabelsService } from './bulk-labels.service';
import { LabelQueueService } from './label-queue';
import { LabelProcessor } from './label.processor';
import { LabelGenerateGuard, LabelTemplateOwnerGuard } from './labels.guards';

/**
 * Labels (§9.9.1, M9): label template (S-23/S-24, §9.12), the custom label
 * renderer, single labels, bulk merged PDFs (§3.27 PARTIAL) and ADD-36 bulk
 * reprint on the §5.7 `label` queue.
 *
 * booking-ops does not export its document plumbing, so DocumentUrlSigner
 * and OBJECT_STORE are provided locally with the same factory shape (both are
 * stateless/config-driven — the QuoteCacheService precedent in booking-ops).
 * If booking-ops later exports them, swap these providers for an import.
 * Downloads ride booking-ops' generic `GET /documents/:id/download` (S-26).
 *
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global.
 */
@Module({
  imports: [CourierFrameworkModule],
  controllers: [LabelsController, ShipmentLabelsController],
  providers: [
    LabelTemplateService,
    LabelsService,
    BulkLabelsService,
    LabelQueueService,
    LabelProcessor,
    LabelGenerateGuard,
    LabelTemplateOwnerGuard,
    DocumentUrlSigner,
    {
      provide: OBJECT_STORE,
      inject: [ConfigService, DocumentUrlSigner],
      useFactory: (config: ConfigService, signer: DocumentUrlSigner) =>
        new LocalFilesystemObjectStore(
          config.get<string>('OBJECT_STORE_DIR') ?? 'var/objects',
          (payload) => signer.hmac(payload),
        ),
    },
  ],
  exports: [LabelsService, BulkLabelsService, LabelTemplateService],
})
export class LabelsModule {}
