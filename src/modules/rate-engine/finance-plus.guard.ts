import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/session.guard';
import type { MemberRole } from '../../auth/session.types';

/** §10.1 "Finance+" = Finance or Owner — defined there and nowhere else. */
const FINANCE_PLUS: readonly MemberRole[] = ['OWNER', 'FINANCE'];

/**
 * Local Finance+ role check for rate-card and zone-map writes (§10.2 "Create
 * / edit rate cards and zone maps" ✓ — ✓ R). Runs AFTER SessionGuard, which
 * establishes identity (INV-1); read endpoints in this module do not use this
 * guard — §10.2 grants read on these objects to every role (Viewer is R).
 */
@Injectable()
export class FinancePlusGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = req.session;
    if (!session) throw new UnauthorizedException('no session');
    if (!FINANCE_PLUS.includes(session.role)) {
      throw new ForbiddenException(
        `role ${session.role} lacks Finance+ permission for rate cards & zone maps (§10.2)`,
      );
    }
    return true;
  }
}
