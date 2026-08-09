import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RuleTraceService } from './rule-trace.service';

/**
 * §9.4.5 trace endpoint. Read-only; every authenticated role may read
 * shipment data (§10.2 "View orders, shipments, tracking" — Viewer R).
 */
@Controller('shipments')
@UseGuards(SessionGuard)
export class RuleTraceController {
  constructor(private readonly traces: RuleTraceService) {}

  @Get(':shipmentId/rule-trace')
  forShipment(
    @Req() req: AuthenticatedRequest,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ) {
    return this.traces.forShipment(req.session.shopId, shipmentId);
  }
}
