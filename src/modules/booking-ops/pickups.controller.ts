import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { PickupService } from './pickup.service';
import { BookingOpsOperatorPlusGuard } from './operator-plus.guard';

interface ScheduleBody {
  shipmentIds?: string[];
}

/**
 * §9.5.5 pickup scheduling (Operator+, §10.2). Shipments are grouped by
 * courier SERVICE only (A4-02); each group gets one schedulePickup call and
 * ONE manifest PDF. Ineligible shipments are reported with their states,
 * never silently skipped (INV-20).
 */
@Controller('pickups')
@UseGuards(SessionGuard)
export class PickupsController {
  constructor(private readonly pickups: PickupService) {}

  @Post('schedule')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BookingOpsOperatorPlusGuard)
  async schedule(@Req() req: AuthenticatedRequest, @Body() body: ScheduleBody) {
    const shipmentIds = (body?.shipmentIds ?? []).filter((id) => typeof id === 'string' && id);
    if (shipmentIds.length === 0) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION',
        message: 'shipmentIds must be a non-empty array',
      });
    }
    return this.pickups.schedulePickups({
      shopId: req.session.shopId,
      shipmentIds,
      actorId: req.session.memberId,
    });
  }
}
