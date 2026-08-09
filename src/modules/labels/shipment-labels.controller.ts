import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { LabelsService } from './labels.service';
import { LabelGenerateGuard } from './labels.guards';
import { LABEL_SIZES, LabelSize } from './labels.types';

interface GenerateLabelBody {
  /** S-23 print-time size choice (Operator+); defaults to the template size. */
  size?: LabelSize;
}

/**
 * §9.9.1 single label: `POST /shipments/:id/label`. Operator+; Finance may
 * also generate and re-download (§10.2). A repeat call on a shipment with an
 * existing unexpired LABEL document is a re-download (§3.11 — allowed in
 * RESTRICTED); only NEW generation is account-state gated. The download
 * itself rides the booking-ops signed-URL path (`GET /documents/:id/download`,
 * S-26), which is generic over document kinds.
 */
@Controller('shipments')
@UseGuards(SessionGuard, LabelGenerateGuard)
export class ShipmentLabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Post(':id/label')
  async generate(
    @Req() req: AuthenticatedRequest,
    @Param('id') shipmentId: string,
    @Body() body: GenerateLabelBody,
  ) {
    if (body?.size !== undefined && !LABEL_SIZES.includes(body.size)) {
      throw new BadRequestException(`unknown label size (S-23): ${body.size}`);
    }
    return this.labels.generateShipmentLabel({
      shopId: req.session.shopId,
      shipmentId,
      actorId: req.session.memberId,
      sizeOverride: body?.size,
    });
  }
}
