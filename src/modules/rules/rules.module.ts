import { Module } from '@nestjs/common';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { RateEngineModule } from '../rate-engine/rate-engine.module';
import { TeamModule } from '../team/team.module';
import { QuoteCacheService } from '../booking/quote-cache.service';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import { RuleEvaluationService } from './rule-evaluation.service';
import { RuleRoutingService } from './rule-routing.service';
import { RuleSimulatorService } from './rule-simulator.service';
import { RuleTraceService } from './rule-trace.service';
import { RuleTraceController } from './rule-trace.controller';
import { SavedZonesController } from './saved-zones.controller';
import { SavedZonesService } from './saved-zones.service';

/**
 * Shipping rules v2 (§9.4, M4) with Addendum C1: ADD-01…ADD-12 condition
 * fields, ADD-13 groups, ADD-14 MANUAL_ONLY, ADD-15 exclusions, ADD-16
 * scheduling, ADD-17 test-fire. The pure §9.4.4 core lives in evaluate.ts;
 * RuleEvaluationService loads its operands; RuleRoutingService is the
 * production path (persisting the §9.4.5 trace and writing the outcome).
 *
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global.
 * QuoteCacheService is provided locally rather than added to BookingModule's
 * exports — it is stateless, so a second instance is equivalent (the same
 * pattern booking-ops uses; this block may not edit shared module files).
 */
@Module({
  imports: [CourierFrameworkModule, RateEngineModule, TeamModule],
  controllers: [RulesController, SavedZonesController, RuleTraceController],
  providers: [
    RulesService,
    SavedZonesService,
    RuleEvaluationService,
    RuleRoutingService,
    RuleSimulatorService,
    RuleTraceService,
    QuoteCacheService,
  ],
  exports: [RuleRoutingService, RuleEvaluationService, RuleSimulatorService, RulesService],
})
export class RulesModule {}
