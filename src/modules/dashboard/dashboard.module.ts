import { Module } from '@nestjs/common';
import { TrackingModule } from '../tracking/tracking.module';
import { TeamModule } from '../team/team.module';
import { ReconFreightModule } from '../recon-freight/recon-freight.module';
import { ReconDisputesBridge } from '../recon-freight/recon-queries.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { RollupService } from './rollup.service';
import {
  RollupProcessor,
  RollupQueueService,
  RollupScheduler,
} from './rollup-queue';
import { RECON_DISPUTES_PROVIDER } from './recon-disputes';

/**
 * §9.10 Dashboard + §5.7 hourly rollups.
 *
 *  - RollupService maintains rollup_hourly_stats (§2.8); the BullMQ shell
 *    in rollup-queue.ts runs it hourly (§5.2 freshness ≤75 min).
 *  - DashboardService/Controller serve every figure from the rollups.
 *  - TrackingModule contributes the S-47 listDelayed seam for the delayed
 *    card; TeamModule contributes the §10.2 RolesGuard catalog.
 *  - RECON_DISPUTES_PROVIDER defaults to zero until the recon block
 *    (weeks 14–15, §14) rebinds it — see recon-disputes.ts.
 *
 * BINDING POINT for the app shell: add DashboardModule to AppModule
 * (src/app.module.ts is outside this module's edit scope).
 */
@Module({
  imports: [TrackingModule, TeamModule, ReconFreightModule],
  controllers: [DashboardController],
  providers: [
    RollupService,
    DashboardService,
    RollupQueueService,
    RollupScheduler,
    RollupProcessor,
    // §3.14 + §3.28 counting rule, served by the recon module (weeks 14–15).
    { provide: RECON_DISPUTES_PROVIDER, useExisting: ReconDisputesBridge },
  ],
  exports: [RollupService, DashboardService, RECON_DISPUTES_PROVIDER],
})
export class DashboardModule {}
