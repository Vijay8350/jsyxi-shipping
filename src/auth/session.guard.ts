import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { SessionService } from './session.service';
import { SESSION_COOKIE, SessionContext } from './session.types';

export interface AuthenticatedRequest extends Request {
  session: SessionContext;
}

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
 * Requires a valid session bound to (shop_id, member_id) (INV-1). Role
 * checks are layered on top by the RBAC guard from the team module — this
 * guard only establishes identity.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('no session');
    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthorizedException('session expired or revoked');
    req.session = session;
    return true;
  }
}
