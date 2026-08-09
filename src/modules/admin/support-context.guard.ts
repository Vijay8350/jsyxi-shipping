import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupportContextService } from './support-context.service';
import { SupportContextRequest } from './admin.types';

export const SUPPORT_CONTEXT_HEADER = 'x-support-context';

/**
 * Credential-adjacent route segments (INV-18, §10.3). A support context never
 * reveals credentials BY CONSTRUCTION: any path carrying these segments is
 * rejected while a support context is active, regardless of the endpoint's
 * own role checks.
 */
const CREDENTIAL_ROUTE_PATTERN =
  /\/courier-accounts\/[^/]+\/(credentials|credential|secret|webhook-secret)(\/|$)/i;

/**
 * A1-07 / §10.3 support-context enforcement, applied alongside AdminGuard on
 * every admin route (module-level). When the request carries a live support
 * context header:
 *   - every non-GET is rejected (read-only, enforced — never trusted),
 *   - credential-adjacent routes are rejected by construction,
 *   - the request is bound to the context's shop and every view is audited
 *     by the endpoints themselves (object ids only, §12).
 * Expired or ended contexts are dead: they fail closed with 401.
 * Requests without the header pass through untouched (normal admin RBAC).
 */
@Injectable()
export class SupportContextGuard implements CanActivate {
  constructor(private readonly contexts: SupportContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SupportContextRequest>();
    const raw = req.headers[SUPPORT_CONTEXT_HEADER];
    const contextId = Array.isArray(raw) ? raw[0] : raw;
    if (!contextId) return true; // no support context — plain admin request

    const ctx = await this.contexts.resolveAlive(contextId);
    if (!ctx) throw new UnauthorizedException('support context expired or ended');

    if (req.method !== 'GET') {
      throw new ForbiddenException('a support context is read-only');
    }
    if (CREDENTIAL_ROUTE_PATTERN.test(req.path)) {
      throw new ForbiddenException('credentials are never visible inside a support context');
    }
    req.supportContext = ctx;
    return true;
  }
}
