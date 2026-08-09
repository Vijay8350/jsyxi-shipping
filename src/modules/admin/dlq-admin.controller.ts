import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { DlqAdminService } from './dlq-admin.service';
import { AdminAuthenticatedRequest } from './admin.types';

/**
 * §8.6 DLQ list + replay. Replay is PLATFORM_ADMIN only — §10.2 denies it to
 * every merchant role and §10.3's table names Platform Admin for DLQ replay.
 */
@Controller('admin/dlq')
@UseGuards(AdminGuard)
export class DlqAdminController {
  constructor(private readonly dlq: DlqAdminService) {}

  @Get('items')
  @AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
  async list(
    @Query('shopId') shopId?: string,
    @Query('queue') queue?: string,
    @Query('includeReplayed', new DefaultValuePipe(false), ParseBoolPipe) includeReplayed?: boolean,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.dlq.listItems({ shopId, queue, includeReplayed, limit, offset });
  }

  @Post('items/:dlqId/replay')
  @AdminRoles('PLATFORM_ADMIN')
  async replay(@Req() req: AdminAuthenticatedRequest, @Param('dlqId') dlqId: string) {
    return this.dlq.replay(req.admin, dlqId);
  }
}
