import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/session.guard';

/**
 * Local Owner-only role check for the track-page settings endpoints — §7.6
 * marks S-31–S-37 and S-49 "Changed by: Owner" (§10.2). Runs AFTER
 * SessionGuard, which establishes the (shop_id, member_id) session (INV-1).
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = req.session;
    if (!session) throw new UnauthorizedException('no session');
    if (session.role !== 'OWNER') {
      throw new ForbiddenException('track page settings are Owner-only (§7.6)');
    }
    return true;
  }
}
