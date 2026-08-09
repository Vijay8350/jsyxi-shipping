import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RolesGuard } from '../team/rbac/roles.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { SavedZonesService } from './saved-zones.service';
import { CreateZoneDto, UpdateZoneDto } from './rules.dto';

/**
 * Saved zones (§9.4.2 zone manager). Same §10.2 row as rules ("Create /
 * edit rules, saved zones"): writes Operator+, reads open to every role.
 */
@Controller('zones')
@UseGuards(SessionGuard)
export class SavedZonesController {
  constructor(private readonly zones: SavedZonesService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.zones.list(req.session.shopId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateZoneDto) {
    return this.zones.create(req.session.shopId, req.session.memberId, dto);
  }

  @Get(':savedZoneId')
  get(@Req() req: AuthenticatedRequest, @Param('savedZoneId', ParseUUIDPipe) savedZoneId: string) {
    return this.zones.get(req.session.shopId, savedZoneId);
  }

  @Put(':savedZoneId')
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('savedZoneId', ParseUUIDPipe) savedZoneId: string,
    @Body() dto: UpdateZoneDto,
  ) {
    return this.zones.update(req.session.shopId, req.session.memberId, savedZoneId, dto);
  }

  @Delete(':savedZoneId')
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('savedZoneId', ParseUUIDPipe) savedZoneId: string,
  ) {
    return this.zones.remove(req.session.shopId, req.session.memberId, savedZoneId);
  }
}
