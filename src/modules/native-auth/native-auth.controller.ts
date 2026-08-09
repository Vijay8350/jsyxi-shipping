import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../../auth/session.guard';
import { SESSION_COOKIE } from '../../auth/session.types';
import {
  AcceptInviteDto,
  CreateInviteDto,
  MagicLinkRequestDto,
  NativeLoginDto,
  PasswordResetConsumeDto,
  PasswordResetRequestDto,
  TokenConsumeDto,
  TotpConfirmDto,
} from './native-auth.dto';
import { DEV_HANDOFF_NOTE, NativeAuthService } from './native-auth.service';

/**
 * OVR-1 direct-login endpoints (`app.jsyxi.com/login`). Everything here is
 * shop-scoped (INV-1). Cookie handling mirrors SessionGuard, which reads the
 * raw `jsyxi_session` cookie.
 */
@Controller('auth')
export class NativeAuthController {
  private readonly sessionTtlMs: number;

  constructor(
    private readonly nativeAuth: NativeAuthService,
    config: ConfigService,
  ) {
    // RW-04: cookie lifetime matches the 12h session TTL.
    this.sessionTtlMs = (config.get<number>('session.ttlSeconds') ?? 43200) * 1000;
  }

  // ---------------- Invites (Owner-only) ----------------

  @Post('native/invites')
  @UseGuards(SessionGuard)
  async createInvite(@Req() req: AuthenticatedRequest, @Body() dto: CreateInviteDto) {
    const result = await this.nativeAuth.createInvite(req.session, dto);
    // Dev/handoff path: v1 sends no email; the plaintext token is returned to
    // the inviting Owner only, structured so a mailer can replace it later.
    return { ...result, devHandoffNote: DEV_HANDOFF_NOTE };
  }

  @Post('native/invites/:inviteId/resend')
  @UseGuards(SessionGuard)
  async resendInvite(@Req() req: AuthenticatedRequest, @Param('inviteId') inviteId: string) {
    const result = await this.nativeAuth.resendInvite(req.session, inviteId);
    return { ...result, devHandoffNote: DEV_HANDOFF_NOTE };
  }

  @Post('native/invites/:inviteId/revoke')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async revokeInvite(@Req() req: AuthenticatedRequest, @Param('inviteId') inviteId: string) {
    await this.nativeAuth.revokeInvite(req.session, inviteId);
  }

  @Post('native/invites/accept')
  async acceptInvite(
    @Req() req: Request,
    @Body() dto: AcceptInviteDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.nativeAuth.acceptInvite(dto, this.nativeAuth.hashIp(req.ip));
    this.setSessionCookie(res, result.sessionToken);
    // Session is issued so the new member can enroll TOTP immediately;
    // password login stays blocked until totp_confirmed (OVR-1).
    return { memberId: result.memberId, totpEnrollment: 'required' };
  }

  // ---------------- TOTP enrollment ----------------

  @Post('native/totp/enroll')
  @UseGuards(SessionGuard)
  async enrollTotp(@Req() req: AuthenticatedRequest) {
    return this.nativeAuth.enrollTotp(req.session);
  }

  @Post('native/totp/confirm')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async confirmTotp(@Req() req: AuthenticatedRequest, @Body() dto: TotpConfirmDto) {
    await this.nativeAuth.confirmTotp(req.session, dto.code, this.nativeAuth.hashIp(req.ip));
  }

  // ---------------- Login ----------------

  @Post('native/login')
  async login(
    @Req() req: Request,
    @Body() dto: NativeLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.nativeAuth.login(dto, this.nativeAuth.hashIp(req.ip));
    this.setSessionCookie(res, result.sessionToken);
    return { memberId: result.context.memberId, role: result.context.role };
  }

  // ---------------- Magic link ----------------

  @Post('native/magic-link')
  async requestMagicLink(@Req() req: Request, @Body() dto: MagicLinkRequestDto) {
    const result = await this.nativeAuth.requestMagicLink(dto, this.nativeAuth.hashIp(req.ip));
    return { ...result, devHandoffNote: DEV_HANDOFF_NOTE };
  }

  @Post('native/magic-link/consume')
  async consumeMagicLink(
    @Req() req: Request,
    @Body() dto: TokenConsumeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.nativeAuth.consumeMagicLink(dto.token, this.nativeAuth.hashIp(req.ip));
    this.setSessionCookie(res, result.sessionToken);
    return { memberId: result.context.memberId, role: result.context.role };
  }

  // ---------------- Password reset ----------------

  @Post('native/password-reset')
  async requestPasswordReset(@Req() req: Request, @Body() dto: PasswordResetRequestDto) {
    const result = await this.nativeAuth.requestPasswordReset(dto, this.nativeAuth.hashIp(req.ip));
    return { ...result, devHandoffNote: DEV_HANDOFF_NOTE };
  }

  @Post('native/password-reset/consume')
  @HttpCode(204)
  async consumePasswordReset(@Req() req: Request, @Body() dto: PasswordResetConsumeDto) {
    await this.nativeAuth.consumePasswordReset(dto, this.nativeAuth.hashIp(req.ip));
  }

  // ---------------- Logout (both auth sources) ----------------

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    await this.nativeAuth.logout(req.session, this.nativeAuth.hashIp(req.ip));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  private setSessionCookie(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true, // §5.7 control 2: TLS is terminated at the platform edge
      sameSite: 'lax',
      path: '/',
      maxAge: this.sessionTtlMs,
    });
  }
}
