import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyService, ResolvedApiKey } from './api-key.service';

export interface ApiKeyRequest extends Request {
  apiKey: ResolvedApiKey;
}

/**
 * ADD-20: authenticates the merchant REST API via `Authorization: Bearer`.
 * The v1 read-only endpoints mount this guard later; scope enforcement per
 * route is layered on top with `ApiKeyService.hasScope`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiKeyRequest>();
    const header = req.headers.authorization;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
    if (!match) throw new UnauthorizedException('missing bearer token');
    const resolved = await this.keys.verify(match[1]);
    if (!resolved) throw new UnauthorizedException('invalid or revoked API key');
    req.apiKey = resolved;
    return true;
  }
}
