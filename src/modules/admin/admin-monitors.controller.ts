import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { BookingFailureMonitorService } from './booking-failure-monitor.service';
import { CourierApiMonitorService } from './courier-api-monitor.service';
import {
  BOOKING_FAILURE_SPIKE_HOURS,
  BOOKING_FAILURE_WINDOW_MINUTES,
  COURIER_API_MONITOR_HOURS,
} from './admin.constants';

/**
 * §9.13 + ADD-32 platform monitors. Read-only, platform-wide by design
 * (§10.3 admin surface): the whole point is cross-merchant visibility.
 */
@Controller('admin/monitors')
@UseGuards(AdminGuard)
@AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
export class AdminMonitorsController {
  constructor(
    private readonly bookingFailures: BookingFailureMonitorService,
    private readonly courierApi: CourierApiMonitorService,
  ) {}

  /** ADD-32: booking failures grouped by reason code across all merchants. */
  @Get('booking-failures')
  async bookingFailuresByReason(
    @Query('windowMinutes', new DefaultValuePipe(BOOKING_FAILURE_WINDOW_MINUTES), ParseIntPipe)
    windowMinutes: number,
  ) {
    return this.bookingFailures.failuresByReason(windowMinutes);
  }

  /** ADD-32 spike view: count by reason × courier by hour, last 24h default. */
  @Get('booking-failures/spike')
  async bookingFailureSpike(
    @Query('hours', new DefaultValuePipe(BOOKING_FAILURE_SPIKE_HOURS), ParseIntPipe)
    hours: number,
  ) {
    return this.bookingFailures.spikeView(hours);
  }

  /** §9.13 courier API error monitor. */
  @Get('courier-api-failures')
  async courierApiFailures(
    @Query('hours', new DefaultValuePipe(COURIER_API_MONITOR_HOURS), ParseIntPipe)
    hours: number,
  ) {
    return this.courierApi.failuresPerCourier(hours);
  }

  /** §3.6: unmapped raw statuses per courier (feeds the status-map editor). */
  @Get('unmapped-statuses')
  async unmappedStatuses(@Query('courierId') courierId?: string) {
    return this.courierApi.unmappedStatuses(courierId);
  }
}
