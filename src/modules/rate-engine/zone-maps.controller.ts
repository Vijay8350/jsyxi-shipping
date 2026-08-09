import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { FinancePlusGuard } from './finance-plus.guard';
import { ZoneMapsService } from './zone-maps.service';
import { CreateZoneMapDto, SealDto } from './rate-engine.dto';

/**
 * Commercial zone map endpoints (§2.3, §4.3, §9.15). Same guard model as
 * rate cards: identity on every route (INV-1), Finance+ on writes (§10.2).
 */
@Controller('zone-maps')
@UseGuards(SessionGuard)
export class ZoneMapsController {
  constructor(private readonly zoneMaps: ZoneMapsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query('serviceId') serviceId?: string) {
    return this.zoneMaps.listZoneMaps(req.session.shopId, serviceId);
  }

  @Post()
  @UseGuards(FinancePlusGuard)
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateZoneMapDto) {
    return this.zoneMaps.createZoneMap(req.session.shopId, req.session.memberId, dto);
  }

  /** INV-11 seal — also called by the booking module via the service. */
  @Post(':zoneMapId/seal')
  @UseGuards(FinancePlusGuard)
  seal(
    @Req() req: AuthenticatedRequest,
    @Param('zoneMapId', ParseUUIDPipe) zoneMapId: string,
    @Body() dto: SealDto,
  ) {
    return this.zoneMaps.seal(req.session.shopId, req.session.memberId, zoneMapId, dto.version);
  }
}
