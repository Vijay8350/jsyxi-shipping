import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/session.guard';

/**
 * Operator+ = OWNER or OPERATOR (§10.1). Bulk booking and pickup scheduling
 * are Operator+ actions (§10.2). A deliberately LOCAL role check on
 * req.session.role, matching the booking module's OperatorPlusGuard (kept
 * local so booking-ops does not depend on unexported booking providers).
 */
@Injectable()
export class BookingOpsOperatorPlusGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.session) throw new UnauthorizedException('no session');
    if (req.session.role !== 'OWNER' && req.session.role !== 'OPERATOR') {
      throw new ForbiddenException('booking operations are Operator+ only (§10.2)');
    }
    return true;
  }
}
