import { Module } from '@nestjs/common';
import { EstimateCostService } from './estimate-cost.service';
import { FinancePlusGuard } from './finance-plus.guard';
import { RateCardsController } from './rate-cards.controller';
import { RateCardsService } from './rate-cards.service';
import { RateEngineController } from './rate-engine.controller';
import { ZoneMapsController } from './zone-maps.controller';
import { ZoneMapsService } from './zone-maps.service';

/**
 * Rate cards & cost engine (§9.15, M15). DatabaseModule, AuthModule and
 * AuditModule are @Global, so PG_POOL, SessionGuard and AuditService inject
 * without imports. RateCardsService/ZoneMapsService are exported so the
 * booking module can seal versions and zone maps when a snapshot first
 * references them (INV-11); EstimateCostService is exported for the rule
 * engine's CHEAPEST action and the ship modal (§4.5).
 */
@Module({
  controllers: [RateCardsController, ZoneMapsController, RateEngineController],
  providers: [RateCardsService, ZoneMapsService, EstimateCostService, FinancePlusGuard],
  exports: [RateCardsService, ZoneMapsService, EstimateCostService],
})
export class RateEngineModule {}
