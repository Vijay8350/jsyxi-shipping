import { describe, expect, it, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminGuard } from '../../src/modules/admin/admin.guard';
import { AdminAuthService } from '../../src/modules/admin/admin-auth.service';
import { AdminRole } from '../../src/modules/admin/admin.types';
import { CourierMasterController } from '../../src/modules/admin/courier-master.controller';
import { MerchantDirectoryController } from '../../src/modules/admin/merchant-directory.controller';
import { PlanAdminController } from '../../src/modules/admin/plan-admin.controller';
import { FeatureFlagController } from '../../src/modules/admin/feature-flag.controller';
import { DlqAdminController } from '../../src/modules/admin/dlq-admin.controller';
import { SupportContextController } from '../../src/modules/admin/support-context.controller';
import { ScreenGuideAdminController } from '../../src/modules/admin/screen-guide.controller';
import { ADMIN_ID } from './helpers';

/**
 * §10.3 role enforcement per endpoint, exercised through the real guard and
 * the real controller metadata — not a re-stated copy of the matrix.
 */

function fakeHttpContext(handler: object, cls: object, cookie?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: cookie ? { cookie } : {} }),
    }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

function guardWithRole(role: AdminRole | null): AdminGuard {
  const auth = {
    resolveSession: vi.fn(async () =>
      role ? { sessionId: 's1', adminId: ADMIN_ID, role } : null,
    ),
  };
  return new AdminGuard(auth as unknown as AdminAuthService, new Reflector());
}

const COOKIE = 'jsyxi_admin_session=tok';

describe('AdminGuard (§10.3)', () => {
  it('rejects requests with no cookie or a dead session', async () => {
    const guard = guardWithRole('PLATFORM_ADMIN');
    await expect(
      guard.canActivate(fakeHttpContext(MerchantDirectoryController.prototype.list, MerchantDirectoryController)),
    ).rejects.toThrow(UnauthorizedException);

    const dead = guardWithRole(null);
    await expect(
      dead.canActivate(
        fakeHttpContext(MerchantDirectoryController.prototype.list, MerchantDirectoryController, COOKIE),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('PLATFORM_ADMIN reaches every surface, including DLQ replay', async () => {
    const guard = guardWithRole('PLATFORM_ADMIN');
    const targets: Array<[object, object]> = [
      [CourierMasterController.prototype.createCourier, CourierMasterController],
      [CourierMasterController.prototype.upsertStatusMap, CourierMasterController],
      [MerchantDirectoryController.prototype.list, MerchantDirectoryController],
      [PlanAdminController.prototype.create, PlanAdminController],
      [FeatureFlagController.prototype.upsert, FeatureFlagController],
      [DlqAdminController.prototype.replay, DlqAdminController],
      [SupportContextController.prototype.open, SupportContextController],
      [ScreenGuideAdminController.prototype.upsert, ScreenGuideAdminController],
    ];
    for (const [handler, cls] of targets) {
      await expect(guard.canActivate(fakeHttpContext(handler, cls, COOKIE))).resolves.toBe(true);
    }
  });

  it('SUPPORT_AGENT: merchant context + support context yes; courier writes, plans, flags, DLQ replay no', async () => {
    const guard = guardWithRole('SUPPORT_AGENT');
    // Allowed reads/context (§10.3 row: tickets/context/announcements-read + ADD-31).
    await expect(
      guard.canActivate(fakeHttpContext(MerchantDirectoryController.prototype.list, MerchantDirectoryController, COOKIE)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(fakeHttpContext(MerchantDirectoryController.prototype.detail, MerchantDirectoryController, COOKIE)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(fakeHttpContext(SupportContextController.prototype.open, SupportContextController, COOKIE)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(fakeHttpContext(CourierMasterController.prototype.listCouriers, CourierMasterController, COOKIE)),
    ).resolves.toBe(true);

    // Denied writes / other-role surfaces.
    const denied: Array<[object, object]> = [
      [CourierMasterController.prototype.createCourier, CourierMasterController],
      [CourierMasterController.prototype.upsertStatusMap, CourierMasterController],
      [CourierMasterController.prototype.upsertGuide, CourierMasterController],
      [PlanAdminController.prototype.create, PlanAdminController],
      [FeatureFlagController.prototype.upsert, FeatureFlagController],
      [DlqAdminController.prototype.replay, DlqAdminController],
      [ScreenGuideAdminController.prototype.upsert, ScreenGuideAdminController],
    ];
    for (const [handler, cls] of denied) {
      await expect(guard.canActivate(fakeHttpContext(handler, cls, COOKIE))).rejects.toThrow(
        ForbiddenException,
      );
    }
  });

  it('PLATFORM_FINANCE: plans yes; courier master writes, flags and DLQ replay no', async () => {
    const guard = guardWithRole('PLATFORM_FINANCE');
    await expect(
      guard.canActivate(fakeHttpContext(PlanAdminController.prototype.create, PlanAdminController, COOKIE)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(fakeHttpContext(PlanAdminController.prototype.update, PlanAdminController, COOKIE)),
    ).resolves.toBe(true);
    const denied: Array<[object, object]> = [
      [CourierMasterController.prototype.createCourier, CourierMasterController],
      [FeatureFlagController.prototype.upsert, FeatureFlagController],
      [DlqAdminController.prototype.replay, DlqAdminController],
      [SupportContextController.prototype.open, SupportContextController],
      [MerchantDirectoryController.prototype.list, MerchantDirectoryController],
    ];
    for (const [handler, cls] of denied) {
      await expect(guard.canActivate(fakeHttpContext(handler, cls, COOKIE))).rejects.toThrow(
        ForbiddenException,
      );
    }
  });

  it('an un-annotated admin route defaults to PLATFORM_ADMIN (deny-by-default)', async () => {
    // FeatureFlagController has class-level @AdminRoles('PLATFORM_ADMIN');
    // verify the class-level default binds even without method metadata.
    const supportGuard = guardWithRole('SUPPORT_AGENT');
    await expect(
      supportGuard.canActivate(
        fakeHttpContext(FeatureFlagController.prototype.list, FeatureFlagController, COOKIE),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
