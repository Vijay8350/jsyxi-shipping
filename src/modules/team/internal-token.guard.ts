import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { safeEqualHex } from '../../common/crypto';

export const INTERNAL_TOKEN_HEADER = 'x-jsyxi-internal-token';

/**
 * Lightweight guard for module-to-module endpoints (§9.1.2): the shopify
 * entry module calls these after it has verified the shop and the staff-user
 * identity, so no session exists at this boundary. A shared hex token in
 * JSYXI_INTERNAL_TOKEN authenticates the caller; comparison is
 * constant-time. If the token is not configured the endpoint is closed
 * (503), never open.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.JSYXI_INTERNAL_TOKEN;
    if (!expected) {
      throw new ServiceUnavailableException(
        'internal endpoints are not configured',
      );
    }
    const req = context.switchToHttp().getRequest<Request>();
    const presented = req.headers[INTERNAL_TOKEN_HEADER];
    const token = Array.isArray(presented) ? presented[0] : presented;
    if (!token || !safeEqualHex(token, expected)) {
      throw new UnauthorizedException('invalid internal token');
    }
    return true;
  }
}
