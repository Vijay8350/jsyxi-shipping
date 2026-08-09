import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Pool } from 'pg';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../../auth/session.guard';
import { PG_POOL } from '../../database/database.module';
import { RequiresPermission } from './rbac/requires-permission.decorator';
import { RolesGuard } from './rbac/roles.guard';
import { AccessRequestsService } from './access-requests.service';
import { InternalTokenGuard } from './internal-token.guard';
import {
  DenyAccessRequestDto,
  GrantAccessRequestDto,
  InternalCreateAccessRequestDto,
  InternalWithdrawAccessRequestDto,
  WithdrawAccessRequestDto,
} from './team.dto';
import { AccessRequestRow, ShopMemberRow } from './team.types';

/**
 * Access requests (§9.1.2, §3.19). Two entry surfaces:
 *
 * - Session-authenticated (this controller): the Owner lists and resolves
 *   pending requests ('team.manage'); an authenticated member can withdraw a
 *   request filed under their own Shopify staff identity.
 * - Internal (InternalAccessRequestsController below): the shopify entry
 *   module calls it from the deny-by-default screen, where the staff user
 *   has a verified entry identity but no session and no member row.
 */
@Controller('access-requests')
@UseGuards(SessionGuard, RolesGuard)
export class AccessRequestsController {
  constructor(
    private readonly requests: AccessRequestsService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** The session member's Shopify staff identity, if they have one (OVR-1). */
  private async staffIdOf(req: AuthenticatedRequest): Promise<string> {
    const { rows } = await this.pool.query<
      Pick<ShopMemberRow, 'shopify_staff_user_id' | 'auth_source'>
    >(
      `SELECT shopify_staff_user_id, auth_source FROM shop_member
        WHERE shop_id = $1 AND member_id = $2`,
      [req.session.shopId, req.session.memberId],
    );
    const member = rows[0];
    if (!member || member.auth_source !== 'SHOPIFY_STAFF') {
      throw new BadRequestException(
        'access requests belong to Shopify staff identities (§9.1.2)',
      );
    }
    return member.shopify_staff_user_id as string;
  }

  /** Owner lists pending requests (pass ?resolution= for other states). */
  @Get()
  @RequiresPermission('team.manage')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('resolution') resolution?: AccessRequestRow['resolution'],
  ) {
    return this.requests.list(req.session.shopId, resolution);
  }

  /** Session-authenticated create variant (§9.1.2 "request access"). */
  @Post()
  async create(@Req() req: AuthenticatedRequest) {
    const staffId = await this.staffIdOf(req);
    return this.requests.create(req.session.shopId, staffId);
  }

  /** Owner grants — GRANTED creates the shop_member row atomically (RW-17). */
  @Post(':requestId/grant')
  @RequiresPermission('team.manage')
  grant(
    @Req() req: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: GrantAccessRequestDto,
  ) {
    return this.requests.grant(
      req.session.shopId,
      req.session.memberId,
      requestId,
      dto,
    );
  }

  @Post(':requestId/deny')
  @RequiresPermission('team.manage')
  deny(
    @Req() req: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DenyAccessRequestDto,
  ) {
    return this.requests.deny(
      req.session.shopId,
      req.session.memberId,
      requestId,
      dto,
    );
  }

  /** Requester withdraws their own request (§3.19 WITHDRAWN). */
  @Post(':requestId/withdraw')
  async withdraw(
    @Req() req: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: WithdrawAccessRequestDto,
  ) {
    const staffId = await this.staffIdOf(req);
    return this.requests.withdraw(req.session.shopId, staffId, requestId, dto);
  }
}

/**
 * Internal surface for the shopify entry module (§9.1.2): it has already
 * verified the shop and the Shopify staff-user identity at entry, so these
 * endpoints accept that identity explicitly. Guarded by InternalTokenGuard —
 * not by SessionGuard, because the requester has no session by definition.
 */
@Controller('internal/shops/:shopId/access-requests')
@UseGuards(InternalTokenGuard)
export class InternalAccessRequestsController {
  constructor(private readonly requests: AccessRequestsService) {}

  @Post()
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: InternalCreateAccessRequestDto,
  ) {
    return this.requests.create(shopId, dto.shopifyStaffUserId);
  }

  @Post(':requestId/withdraw')
  withdraw(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: InternalWithdrawAccessRequestDto,
  ) {
    return this.requests.withdraw(
      shopId,
      dto.shopifyStaffUserId,
      requestId,
      dto,
    );
  }
}
