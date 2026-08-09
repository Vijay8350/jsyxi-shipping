import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_ROLES_KEY } from './admin-roles.decorator';
import { AdminAuthService } from './admin-auth.service';
import { ADMIN_SESSION_COOKIE } from './admin.constants';
import { AdminAuthenticatedRequest, AdminRole } from './admin.types';

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * §10.3 admin gate: resolves the admin_session cookie to an AdminContext and
 * enforces the @AdminRoles(...) metadata on the handler. A handler with no
 * role metadata is PLATFORM_ADMIN-only (deny-by-default). Role checks are
 * per-endpoint as §10.3's table requires; identity alone never suffices.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    const token = readCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('no admin session');
    const admin = await this.adminAuth.resolveSession(token);
    if (!admin) throw new UnauthorizedException('admin session expired or revoked');

    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const allowed = roles && roles.length > 0 ? roles : (['PLATFORM_ADMIN'] as AdminRole[]);
    if (!allowed.includes(admin.role)) {
      throw new ForbiddenException(`requires one of: ${allowed.join(', ')}`);
    }
    req.admin = admin;
    return true;
  }
}
