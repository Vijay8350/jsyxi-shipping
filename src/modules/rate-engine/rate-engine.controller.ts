import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { EstimateCostService } from './estimate-cost.service';
import { EstimateCostDto } from './rate-engine.dto';

/**
 * estimateCost endpoint (§9.15) — the ship-modal / order-row estimate and the
 * input to the CHEAPEST rule action (§4.5). Read-only: open to every
 * authenticated role (§10.2 grants read on rate cards to all, Viewer is R).
 */
@Controller('rate-engine')
@UseGuards(SessionGuard)
export class RateEngineController {
  constructor(private readonly estimates: EstimateCostService) {}

  @Post('estimate')
  estimate(@Req() req: AuthenticatedRequest, @Body() dto: EstimateCostDto) {
    return this.estimates.estimateCost({ ...dto, shopId: req.session.shopId });
  }
}
