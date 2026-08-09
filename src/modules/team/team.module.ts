import { Module } from '@nestjs/common';
import { AccessRequestsController, InternalAccessRequestsController } from './access-requests.controller';
import { AccessRequestsService } from './access-requests.service';
import { InternalTokenGuard } from './internal-token.guard';
import { RolesGuard } from './rbac/roles.guard';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

/**
 * Team & Roles module (§9.1.2, §10, OVR-1). DatabaseModule, AuthModule and
 * AuditModule are @Global, so PG_POOL, SessionService/SessionGuard and
 * AuditService inject without imports. RolesGuard and the PERMISSIONS
 * catalog are exported so other feature modules can declare
 * @RequiresPermission on their own endpoints against the same §10.2 matrix.
 */
@Module({
  controllers: [
    TeamController,
    AccessRequestsController,
    InternalAccessRequestsController,
  ],
  providers: [TeamService, AccessRequestsService, RolesGuard, InternalTokenGuard],
  exports: [TeamService, AccessRequestsService, RolesGuard],
})
export class TeamModule {}
