import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { CodDueSweepService } from './cod-due-sweep.service';
import { CodExpectationService } from './cod-expectation.service';
import { CodImportService } from './cod-import.service';
import { CodQueryService } from './cod-query.service';
import { CodReconTrackingSeam } from './cod-recon-tracking-seam';
import { CodSettingsService } from './cod-settings.service';
import { CodReconProcessor, CodReconQueueService } from './recon-cod-queue';
import { ReconCodController } from './recon-cod.controller';

/**
 * §9.17.3 COD reconciliation (M17, COD half): the expected ledger, upload-only
 * remittance import with idempotent partial allocations, the F-21 due sweep
 * and S-29/S-30 settings.
 *
 * Wiring left to the parent (this module must not edit other modules):
 *  - import ReconCodModule into app.module.ts;
 *  - add CodReconTrackingSeam to the TRACKING_SEAMS composite in
 *    tracking.module.ts: onDelivered, plus onRtoInitiated /
 *    onTerminalMovement for the RTO_* movement states (§4.7).
 *
 * INV-23: nothing in this module pays out, holds or settles money — it only
 * records cash that moved between the courier and the merchant.
 */
@Module({
  imports: [AuditModule],
  controllers: [ReconCodController],
  providers: [
    CodSettingsService,
    CodExpectationService,
    CodImportService,
    CodDueSweepService,
    CodQueryService,
    CodReconTrackingSeam,
    CodReconQueueService,
    CodReconProcessor,
  ],
  exports: [CodReconTrackingSeam, CodExpectationService, CodSettingsService],
})
export class ReconCodModule {}
