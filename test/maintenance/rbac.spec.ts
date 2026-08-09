import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RolesGuard } from '../../src/modules/team/rbac/roles.guard';
import { PERMISSION_KEY } from '../../src/modules/team/rbac/requires-permission.decorator';
import { hasPermission } from '../../src/modules/team/rbac/permissions';
import { MaintenanceController } from '../../src/modules/maintenance/maintenance.controller';
import { MemberRole } from '../../src/auth/session.types';

function contextWith(session?: { role: MemberRole }): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ session }) }),
  } as unknown as ExecutionContext;
}

const reflector = {
  getAllAndOverride: () => 'test_shipments.bulk_delete' as const,
};

describe('§10.2 test_shipments.bulk_delete — Owner-only', () => {
  it('the §10.2 catalog grants the permission to OWNER alone', () => {
    expect(hasPermission('OWNER', 'test_shipments.bulk_delete')).toBe(true);
    for (const role of ['OPERATOR', 'FINANCE', 'VIEWER'] as const) {
      expect(hasPermission(role, 'test_shipments.bulk_delete')).toBe(false);
    }
  });

  it('RolesGuard admits OWNER and rejects every other merchant role', () => {
    const guard = new RolesGuard(reflector as never);
    expect(
      guard.canActivate(contextWith({ role: 'OWNER' })),
    ).toBe(true);
    for (const role of ['OPERATOR', 'FINANCE', 'VIEWER'] as const) {
      expect(() => guard.canActivate(contextWith({ role }))).toThrow(
        ForbiddenException,
      );
    }
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('both maintenance endpoints carry the Owner-only permission metadata', () => {
    for (const handler of [
      MaintenanceController.prototype.purgePreview,
      MaintenanceController.prototype.deleteTestShipments,
    ]) {
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe(
        'test_shipments.bulk_delete',
      );
    }
  });
});
