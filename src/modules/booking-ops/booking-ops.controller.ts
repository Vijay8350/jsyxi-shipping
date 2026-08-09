import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { BulkBookingService } from './bulk-booking.service';
import { BookingOpsOperatorPlusGuard } from './operator-plus.guard';

interface BulkBody {
  orderIds?: string[];
}

/**
 * §9.5.2 bulk booking endpoints. Booking actions are Operator+ (§10.2); the
 * batch status read is available to every authenticated role. Structured
 * failures are never silent (INV-20): validation → 422, the S-21 per-shop
 * concurrency quota → a 429-style structured refusal.
 */
@Controller('booking/bulk')
@UseGuards(SessionGuard)
export class BookingOpsController {
  constructor(private readonly bulk: BulkBookingService) {}

  /** §9.5.2: enqueue a bulk booking job (≤1,000 orders). */
  @Post()
  @UseGuards(BookingOpsOperatorPlusGuard)
  async create(@Req() req: AuthenticatedRequest, @Body() body: BulkBody) {
    const result = await this.bulk.createBatch({
      shopId: req.session.shopId,
      actorId: req.session.memberId,
      orderIds: body?.orderIds ?? [],
    });
    if (!result.created) {
      if (result.code === 'BULK_CONCURRENCY_EXCEEDED') {
        // 429-style structured refusal (S-21).
        throw new HttpException(result, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new UnprocessableEntityException(result);
    }
    return result;
  }

  /** §9.5.2 live progress + per-order results. Shop-scoped (INV-1). */
  @Get(':batchId')
  async get(@Req() req: AuthenticatedRequest, @Param('batchId') batchId: string) {
    const batch = await this.bulk.getBatch(req.session.shopId, batchId);
    if (!batch) throw new NotFoundException('batch not found');
    return batch;
  }

  /** §9.5.2 one-click retry: a new batch over only the failed orders. */
  @Post(':batchId/retry')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BookingOpsOperatorPlusGuard)
  async retry(@Req() req: AuthenticatedRequest, @Param('batchId') batchId: string) {
    const result = await this.bulk.retryFailed({
      shopId: req.session.shopId,
      batchId,
      actorId: req.session.memberId,
    });
    if (!result.created) {
      if (result.code === 'BULK_CONCURRENCY_EXCEEDED') {
        throw new HttpException(result, HttpStatus.TOO_MANY_REQUESTS);
      }
      if (result.code === 'NOT_TERMINAL') throw new NotFoundException(result);
      throw new UnprocessableEntityException(result);
    }
    return result;
  }
}
