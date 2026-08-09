import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../../../auth/session.guard';
import {
  ApiKeyScope,
  ApiKeyService,
  ApiKeyView,
} from './api-key.service';

interface CreateApiKeyBody {
  name: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute?: number;
}

/**
 * ADD-20 key management endpoints. Owner-only (§10.2 settings/credentials
 * acts are Owner) — a local role check; the team module's RBAC guard is not
 * this module's concern. The v1 read-only data endpoints mount ApiKeyGuard
 * later and are NOT built here.
 */
@Controller('api-keys')
@UseGuards(SessionGuard)
export class ApiKeyController {
  constructor(private readonly keys: ApiKeyService) {}

  private requireOwner(req: AuthenticatedRequest): void {
    if (req.session.role !== 'OWNER') {
      throw new ForbiddenException('API key management is Owner-only (§10.2)');
    }
  }

  @Get()
  list(@Req() req: AuthenticatedRequest): Promise<ApiKeyView[]> {
    this.requireOwner(req);
    return this.keys.list(req.session.shopId);
  }

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateApiKeyBody,
  ): Promise<{ plaintext: string; key: ApiKeyView }> {
    this.requireOwner(req);
    return this.keys.create({
      shopId: req.session.shopId,
      name: body.name,
      scopes: body.scopes,
      rateLimitPerMinute: body.rateLimitPerMinute,
      createdBy: req.session.memberId,
    });
  }

  @Post(':keyId/rotate')
  rotate(
    @Req() req: AuthenticatedRequest,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ): Promise<{ plaintext: string; key: ApiKeyView }> {
    this.requireOwner(req);
    return this.keys.rotate(keyId, req.session.shopId, req.session.memberId);
  }

  @Post(':keyId/revoke')
  revoke(
    @Req() req: AuthenticatedRequest,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ): Promise<ApiKeyView> {
    this.requireOwner(req);
    return this.keys.revoke(keyId, req.session.shopId, req.session.memberId);
  }
}
