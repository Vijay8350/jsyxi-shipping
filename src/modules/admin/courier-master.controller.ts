import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { CourierMasterService } from './courier-master.service';
import {
  CreateCourierDto,
  CreateServiceDto,
  CreateServiceVersionDto,
  SetCredentialFieldsDto,
  SetStatusMapDto,
  UpdateCourierDto,
  UpdateServiceDto,
  UpsertCourierGuideDto,
} from './courier-master.dto';
import { AdminAuthenticatedRequest } from './admin.types';

/**
 * §9.13 Courier Master endpoints. Reads are PLATFORM_ADMIN + SUPPORT_AGENT
 * (support needs courier structure to read tickets in context); every write
 * is PLATFORM_ADMIN only (§10.3).
 */
@Controller('admin/courier-master')
@UseGuards(AdminGuard)
export class CourierMasterController {
  constructor(private readonly courierMaster: CourierMasterService) {}

  @Get('couriers')
  @AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
  async listCouriers() {
    return this.courierMaster.listCouriers();
  }

  @Get('couriers/:courierId')
  @AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
  async courierDetail(@Param('courierId') courierId: string) {
    return this.courierMaster.courierDetail(courierId);
  }

  @Post('couriers')
  @AdminRoles('PLATFORM_ADMIN')
  async createCourier(@Req() req: AdminAuthenticatedRequest, @Body() dto: CreateCourierDto) {
    return this.courierMaster.createCourier(req.admin, dto);
  }

  @Patch('couriers/:courierId')
  @HttpCode(204)
  @AdminRoles('PLATFORM_ADMIN')
  async updateCourier(
    @Req() req: AdminAuthenticatedRequest,
    @Param('courierId') courierId: string,
    @Body() dto: UpdateCourierDto,
  ) {
    await this.courierMaster.updateCourier(req.admin, courierId, dto);
  }

  @Put('couriers/:courierId/credential-fields')
  @HttpCode(204)
  @AdminRoles('PLATFORM_ADMIN')
  async setCredentialFields(
    @Req() req: AdminAuthenticatedRequest,
    @Param('courierId') courierId: string,
    @Body() dto: SetCredentialFieldsDto,
  ) {
    await this.courierMaster.setCredentialFields(req.admin, courierId, dto.fields);
  }

  @Post('couriers/:courierId/services')
  @AdminRoles('PLATFORM_ADMIN')
  async createService(
    @Req() req: AdminAuthenticatedRequest,
    @Param('courierId') courierId: string,
    @Body() dto: CreateServiceDto,
  ) {
    return this.courierMaster.createService(req.admin, courierId, dto);
  }

  @Patch('services/:serviceId')
  @HttpCode(204)
  @AdminRoles('PLATFORM_ADMIN')
  async updateService(
    @Req() req: AdminAuthenticatedRequest,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    await this.courierMaster.updateService(req.admin, serviceId, dto);
  }

  @Get('services/:serviceId/versions')
  @AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
  async listServiceVersions(@Param('serviceId') serviceId: string) {
    return this.courierMaster.listServiceVersions(serviceId);
  }

  @Post('services/:serviceId/versions')
  @AdminRoles('PLATFORM_ADMIN')
  async createServiceVersion(
    @Req() req: AdminAuthenticatedRequest,
    @Param('serviceId') serviceId: string,
    @Body() dto: CreateServiceVersionDto,
  ) {
    return this.courierMaster.createServiceVersion(req.admin, serviceId, dto);
  }

  @Get('couriers/:courierId/status-map')
  @AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
  async listStatusMap(@Param('courierId') courierId: string) {
    return this.courierMaster.listStatusMap(courierId);
  }

  @Put('couriers/:courierId/status-map')
  @AdminRoles('PLATFORM_ADMIN')
  async upsertStatusMap(
    @Req() req: AdminAuthenticatedRequest,
    @Param('courierId') courierId: string,
    @Body() dto: SetStatusMapDto,
  ) {
    return this.courierMaster.upsertStatusMap(req.admin, courierId, dto);
  }

  @Delete('status-map/:mapId')
  @HttpCode(204)
  @AdminRoles('PLATFORM_ADMIN')
  async deleteStatusMapEntry(@Req() req: AdminAuthenticatedRequest, @Param('mapId') mapId: string) {
    await this.courierMaster.deleteStatusMapEntry(req.admin, mapId);
  }

  /** §3.6/§9.13: which raw statuses still need a mapping row. */
  @Get('unmapped-statuses')
  @AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
  async unmappedStatuses(@Query('courierId') courierId?: string) {
    return this.courierMaster.listUnmappedStatuses(courierId);
  }

  @Put('couriers/:courierId/guide')
  @AdminRoles('PLATFORM_ADMIN')
  async upsertGuide(
    @Req() req: AdminAuthenticatedRequest,
    @Param('courierId') courierId: string,
    @Body() dto: UpsertCourierGuideDto,
  ) {
    return this.courierMaster.upsertGuide(req.admin, courierId, dto);
  }
}
