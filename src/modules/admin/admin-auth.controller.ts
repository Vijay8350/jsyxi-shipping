import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { AdminAuthService } from './admin-auth.service';
import {
  AdminLoginDto,
  AdminTotpConfirmDto,
  AdminTotpEnrollDto,
  CreateAdminUserDto,
} from './admin-auth.dto';
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_HOURS } from './admin.constants';
import { AdminAuthenticatedRequest } from './admin.types';

/**
 * §10.3 admin auth endpoints (admin.jsyxi.com). Login/TOTP enrollment are
 * unauthenticated (password-gated); staff provisioning is PLATFORM_ADMIN.
 * Cookie handling mirrors AdminGuard, which reads the raw cookie.
 */
@Controller('admin/auth')
export class AdminAuthController {
  private readonly sessionTtlMs = ADMIN_SESSION_TTL_HOURS * 3600 * 1000;

  constructor(
    private readonly adminAuth: AdminAuthService,
    // ConfigService injected for symmetry with the merchant auth controller;
    // the TTL itself is a module constant (admin.constants.ts).
    _config: ConfigService,
  ) {}

  @Post('login')
  async login(
    @Req() req: Request,
    @Body() dto: AdminLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuth.login(dto, this.adminAuth.hashIp(req.ip));
    this.setSessionCookie(res, result.sessionToken);
    return { adminId: result.context.adminId, role: result.context.role };
  }

  @Post('totp/enroll')
  async enrollTotp(@Body() dto: AdminTotpEnrollDto) {
    return this.adminAuth.enrollTotp(dto);
  }

  @Post('totp/confirm')
  @HttpCode(204)
  async confirmTotp(@Req() req: Request, @Body() dto: AdminTotpConfirmDto) {
    await this.adminAuth.confirmTotp(dto, this.adminAuth.hashIp(req.ip));
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async logout(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.adminAuth.logout(req.admin, this.adminAuth.hashIp(req.ip));
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
  }

  // ---------------- Staff provisioning (PLATFORM_ADMIN) ----------------

  @Post('users')
  @UseGuards(AdminGuard)
  @AdminRoles('PLATFORM_ADMIN')
  async createUser(@Req() req: AdminAuthenticatedRequest, @Body() dto: CreateAdminUserDto) {
    return this.adminAuth.createAdminUser(req.admin, dto);
  }

  @Get('users')
  @UseGuards(AdminGuard)
  @AdminRoles('PLATFORM_ADMIN')
  async listUsers() {
    return this.adminAuth.listAdminUsers();
  }

  @Post('users/:adminId/deactivate')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @AdminRoles('PLATFORM_ADMIN')
  async deactivate(@Req() req: AdminAuthenticatedRequest, @Param('adminId') adminId: string) {
    await this.adminAuth.setAdminActive(req.admin, adminId, false);
  }

  @Post('users/:adminId/reactivate')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @AdminRoles('PLATFORM_ADMIN')
  async reactivate(@Req() req: AdminAuthenticatedRequest, @Param('adminId') adminId: string) {
    await this.adminAuth.setAdminActive(req.admin, adminId, true);
  }

  private setSessionCookie(res: Response, token: string): void {
    res.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true, // §5.7 control 2: TLS is terminated at the platform edge
      sameSite: 'lax',
      path: '/',
      maxAge: this.sessionTtlMs,
    });
  }
}
