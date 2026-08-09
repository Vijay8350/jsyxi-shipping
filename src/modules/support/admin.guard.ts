import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { safeEqualHex } from '../../common/crypto';

export const ADMIN_TOKEN_HEADER = 'x-admin-token';
export const ADMIN_ID_HEADER = 'x-admin-id';

/** Placeholder admin identity until the §10.3 admin-auth module lands. */
export const UNATTRIBUTED_ADMIN_ID = '00000000-0000-0000-0000-000000000000';

export interface AdminRequest extends Request {
  adminId: string;
}

/**
 * SEAM — lightweight admin guard. The full §10.3 admin authentication
 * (MFA-backed RBAC over admin_user/admin_session from migration 0017) is a
 * sibling module in flight; until it lands, admin endpoints are protected by
 * a shared token in the X-Admin-Token header compared against the configured
 * `internalToken` (constant-time). If no token is configured the admin
 * surface is closed (503), never open. The sibling module replaces this
 * guard and supplies a real admin identity; until then an optional
 * X-Admin-Id header attributes actions, defaulting to UNATTRIBUTED_ADMIN_ID.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('internalToken') ?? '';
    if (!expected) {
      throw new ServiceUnavailableException(
        'admin endpoints are not configured',
      );
    }
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const presented = req.headers[ADMIN_TOKEN_HEADER];
    const token = Array.isArray(presented) ? presented[0] : presented;
    if (!token || !safeEqualHex(token, expected)) {
      throw new UnauthorizedException('invalid admin token');
    }
    const adminId = req.headers[ADMIN_ID_HEADER];
    req.adminId =
      (Array.isArray(adminId) ? adminId[0] : adminId) || UNATTRIBUTED_ADMIN_ID;
    return true;
  }
}
