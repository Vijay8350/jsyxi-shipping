import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedRequest } from '../../../auth/session.guard';
import { PERMISSION_KEY } from './requires-permission.decorator';
import { canRead, hasPermission, PERMISSIONS, PermissionKey } from './permissions';

/**
 * §10 RBAC guard. Runs AFTER SessionGuard and authorizes purely on
 * req.session.role against the §10.2 catalog — "No access" never reaches
 * this guard because it is the absence of a shop_member row, and without a
 * member row there is no session (§10.1, §9.1.2 deny-by-default).
 *
 * Deny rows (§10.2 `—` × 4, e.g. 'credentials.read', 'dlq.replay') have an
 * empty allow set, so every merchant role — Owner included — is rejected
 * here; the denial is data, not an absent check.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const key = this.reflector.getAllAndOverride<PermissionKey | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No @RequiresPermission metadata: identity (SessionGuard) is enough.
    if (!key) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = req.session;
    if (!session) throw new UnauthorizedException('no session');

    const ruleDef = PERMISSIONS[key];
    if (!ruleDef) {
      // Programming error: a permission name that is not in §10.2.
      throw new Error(`unknown permission '${String(key)}'`);
    }
    /**
     * §10.2 distinguishes `✓` (may act) from `R` (may read only), and the
     * catalog encodes both — `allow` and `readOnly`. Checking `allow` alone
     * collapsed that distinction and denied every `R` role outright, which
     * made Viewer unable to view anything: it holds `R` on orders.view and
     * nothing else, so it was locked out of the product entirely.
     *
     * A safe method reads; anything else writes. GET/HEAD/OPTIONS therefore
     * consult canRead, and every mutation still requires `allow`, so this
     * grants exactly what the matrix already said and nothing more.
     */
    // Absent method is treated as a WRITE, not a read: a guard that cannot
    // tell what it is authorizing must choose the stricter branch.
    const method = String(req.method ?? '').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const permitted = isRead
      ? canRead(session.role, key)
      : hasPermission(session.role, key);

    if (!permitted) {
      throw new ForbiddenException(
        `role ${session.role} lacks permission '${String(key)}'` +
          (isRead ? '' : ' for this action'),
      );
    }
    return true;
  }
}
