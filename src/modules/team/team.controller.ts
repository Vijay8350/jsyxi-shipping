import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RequiresPermission } from './rbac/requires-permission.decorator';
import { RolesGuard } from './rbac/roles.guard';
import { TeamService } from './team.service';
import {
  ChangeRoleDto,
  GrantRoleDto,
  RevokeMemberDto,
  TransferOwnershipDto,
} from './team.dto';

/**
 * Team & Roles endpoints (§9.1.2). Owner-only: every route requires the
 * §10.2 'team.manage' permission, which the matrix grants to Owner alone.
 * SessionGuard establishes identity (INV-1), RolesGuard authorizes the role.
 */
@Controller('team')
@UseGuards(SessionGuard, RolesGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  /** §9.1.2: list each known staff user with role, last active, grant state. */
  @Get('members')
  @RequiresPermission('team.manage')
  listMembers(@Req() req: AuthenticatedRequest) {
    return this.team.listMembers(req.session.shopId);
  }

  /** §9.1.2 + §12: the role-change audit trail, from audit_log. */
  @Get('audit-trail')
  @RequiresPermission('team.manage')
  getAuditTrail(
    @Req() req: AuthenticatedRequest,
    @Query('memberId') memberId?: string,
  ) {
    return this.team.getAuditTrail(req.session.shopId, memberId);
  }

  /** Grant a role to a known Shopify staff user (SHOPIFY_STAFF, OVR-1). */
  @Post('members')
  @RequiresPermission('team.manage')
  grantRole(@Req() req: AuthenticatedRequest, @Body() dto: GrantRoleDto) {
    return this.team.grantRole(req.session.shopId, req.session.memberId, dto);
  }

  @Patch('members/:memberId')
  @RequiresPermission('team.manage')
  changeRole(
    @Req() req: AuthenticatedRequest,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.team.changeRole(
      req.session.shopId,
      req.session.memberId,
      memberId,
      dto,
    );
  }

  @Post('members/:memberId/revoke')
  @RequiresPermission('team.manage')
  revokeMember(
    @Req() req: AuthenticatedRequest,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: RevokeMemberDto,
  ) {
    return this.team.revokeMember(
      req.session.shopId,
      req.session.memberId,
      memberId,
      dto,
    );
  }

  /**
   * §9.1.2 Owner transfer. The body names the target member AND the role the
   * current Owner takes after the transfer (never OWNER).
   */
  @Post('owner/transfer')
  @RequiresPermission('team.manage')
  transferOwnership(
    @Req() req: AuthenticatedRequest,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.team.transferOwnership(
      req.session.shopId,
      req.session.memberId,
      dto,
    );
  }
}
