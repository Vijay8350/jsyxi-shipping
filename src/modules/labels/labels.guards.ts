import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/session.guard';

/**
 * Local role checks (§10.1/§10.2), kept local to the labels module so it does
 * not depend on other modules' unexported providers — the same convention as
 * booking-ops' BookingOpsOperatorPlusGuard.
 */

/** S-23/S-24 template changes are Owner-only (§7.4 "Changed by"). */
@Injectable()
export class LabelTemplateOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.session) throw new UnauthorizedException('no session');
    if (req.session.role !== 'OWNER') {
      throw new ForbiddenException('label template changes are Owner-only (§7.4)');
    }
    return true;
  }
}

/**
 * §9.9.1 label generation is Operator+; Finance may also generate and
 * re-download labels (§10.2).
 */
@Injectable()
export class LabelGenerateGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.session) throw new UnauthorizedException('no session');
    const role = req.session.role;
    if (role !== 'OWNER' && role !== 'OPERATOR' && role !== 'FINANCE') {
      throw new ForbiddenException('label generation is Operator+ or Finance (§10.2)');
    }
    return true;
  }
}
