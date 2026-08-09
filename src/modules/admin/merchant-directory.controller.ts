import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import {
  MerchantDirectoryService,
  MerchantSort,
} from './merchant-directory.service';

/**
 * §9.13 merchant list/detail + the ADD-31 health board. Read-only, no PII
 * (§10.3). SUPPORT_AGENT is allowed: "support sees 'pickup address missing'
 * before the merchant complains" (ADD-31).
 */
@Controller('admin/merchants')
@UseGuards(AdminGuard)
@AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
export class MerchantDirectoryController {
  constructor(private readonly merchants: MerchantDirectoryService) {}

  @Get()
  async list(
    @Query('sort') sort?: MerchantSort,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.merchants.listMerchants({ sort, limit, offset });
  }

  @Get(':shopId')
  async detail(@Param('shopId') shopId: string) {
    return this.merchants.merchantDetail(shopId);
  }
}
