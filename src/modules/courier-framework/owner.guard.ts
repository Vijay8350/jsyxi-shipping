import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/session.guard';

/**
 * §9.3.3 courier account management is Owner-only. A deliberately LOCAL
 * role check on req.session.role (runs after SessionGuard) — the team
 * module's §10.2 RolesGuard catalog is not extended for these routes.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.session) throw new UnauthorizedException('no session');
    if (req.session.role !== 'OWNER') {
      throw new ForbiddenException('courier account management is Owner-only (§9.3.3)');
    }
    return true;
  }
}
