import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/session.guard';

/**
 * Operator+ = OWNER or OPERATOR (§10.1). Booking, cancellation and
 * OUTCOME_UNKNOWN resolution are Operator+ actions (§10.2). A deliberately
 * LOCAL role check on req.session.role, like the courier module's OwnerGuard.
 */
@Injectable()
export class OperatorPlusGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.session) throw new UnauthorizedException('no session');
    if (req.session.role !== 'OWNER' && req.session.role !== 'OPERATOR') {
      throw new ForbiddenException('booking actions are Operator+ only (§10.2)');
    }
    return true;
  }
}
