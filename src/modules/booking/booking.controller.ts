import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { BookingService } from './booking.service';
import { BookingWorkerService } from './booking-worker.service';
import { CancellationService } from './cancellation.service';
import { ShipModalService } from './ship-modal.service';
import { OperatorPlusGuard } from './operator-plus.guard';

interface BookBody {
  serviceId?: string;
  packageProfileId?: string;
  expectedVersion?: number;
}

interface ResolveOutcomeBody {
  outcome?: 'CONFIRMED' | 'FAILED';
  awb?: string;
}

/**
 * Single-booking endpoints (§9.5.1, §9.5.5) and the Operator resolution of
 * OUTCOME_UNKNOWN (§3.2, §9.5.4). Booking actions are Operator+ (§10.2);
 * the ship modal is readable by every authenticated role (§10.2 row 1).
 * Structured guard failures return 422 with the failure body — never silent
 * (INV-20).
 */
@Controller('shipments')
@UseGuards(SessionGuard)
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly worker: BookingWorkerService,
    private readonly cancellation: CancellationService,
    private readonly shipModal: ShipModalService,
  ) {}

  /** §9.5.1: the ship-modal data (F-20 profile, F-24 with "no weight" lines,
   *  per-candidate estimate + EDD, COD-split warning). */
  @Get(':id/ship-modal')
  getShipModal(@Req() req: AuthenticatedRequest, @Param('id') shipmentId: string) {
    return this.shipModal.getShipModal(req.session.shopId, shipmentId);
  }

  /** §9.5.1: the member book action → §3.2 DRAFT → QUEUED. */
  @Post(':id/book')
  @HttpCode(200)
  @UseGuards(OperatorPlusGuard)
  async book(
    @Req() req: AuthenticatedRequest,
    @Param('id') shipmentId: string,
    @Body() body: BookBody,
  ) {
    const result = await this.booking.queueBooking({
      shopId: req.session.shopId,
      shipmentId,
      actorId: req.session.memberId,
      serviceId: body?.serviceId,
      packageProfileId: body?.packageProfileId,
      expectedVersion: body?.expectedVersion,
    });
    if (!result.queued) {
      throw new UnprocessableEntityException(result);
    }
    return result;
  }

  /** §9.5.5: pre-pickup cancellation (§3.3). */
  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(OperatorPlusGuard)
  async cancel(@Req() req: AuthenticatedRequest, @Param('id') shipmentId: string) {
    const result = await this.cancellation.requestCancellation({
      shopId: req.session.shopId,
      shipmentId,
      actorId: req.session.memberId,
    });
    if (!result.cancelled && (result.code === 'SHIPMENT_NOT_FOUND' || result.code === 'INVALID_BOOKING_STATE' || result.code === 'INVALID_CUSTODY_STATE')) {
      throw new UnprocessableEntityException(result);
    }
    return result;
  }

  /** §3.2 / §9.5.4: explicit Operator resolution of OUTCOME_UNKNOWN. */
  @Post(':id/resolve-outcome')
  @HttpCode(200)
  @UseGuards(OperatorPlusGuard)
  async resolveOutcome(
    @Req() req: AuthenticatedRequest,
    @Param('id') shipmentId: string,
    @Body() body: ResolveOutcomeBody,
  ) {
    if (body?.outcome === 'CONFIRMED') {
      if (!body.awb || body.awb.trim() === '') {
        throw new UnprocessableEntityException({
          resolved: false,
          code: 'AWB_REQUIRED',
        });
      }
      const result = await this.worker.resolveOutcomeUnknownByOperator(
        req.session.shopId,
        shipmentId,
        req.session.memberId,
        { outcome: 'CONFIRMED', awb: body.awb },
      );
      if (!result.resolved) throw new UnprocessableEntityException(result);
      return result;
    }
    if (body?.outcome === 'FAILED') {
      const result = await this.worker.resolveOutcomeUnknownByOperator(
        req.session.shopId,
        shipmentId,
        req.session.memberId,
        { outcome: 'FAILED' },
      );
      if (!result.resolved) throw new UnprocessableEntityException(result);
      return result;
    }
    // No explicit decision → the lookupByReference resolver (§9.5.4).
    const result = await this.worker.resolveOutcomeUnknown(req.session.shopId, shipmentId);
    if (!result.resolved) throw new UnprocessableEntityException(result);
    return result;
  }
}
