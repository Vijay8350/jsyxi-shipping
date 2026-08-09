import {
  ForbiddenException,
  UnauthorizedException,
  ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../src/auth/session.types';
import { RolesGuard } from '../../src/modules/team/rbac/roles.guard';
import { PermissionKey } from '../../src/modules/team/rbac/permissions';

function contextWith(session?: Partial<SessionContext>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ session }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(key: PermissionKey | undefined): RolesGuard {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(key);
  return new RolesGuard(reflector);
}

describe('RolesGuard (§10)', () => {
  it('allows when no @RequiresPermission metadata is present', () => {
    expect(guardWith(undefined).canActivate(contextWith())).toBe(true);
  });

  it('allows a role granted by §10.2 (Owner → team.manage)', () => {
    const guard = guardWith('team.manage');
    expect(
      guard.canActivate(contextWith({ role: 'OWNER' })),
    ).toBe(true);
  });

  it('rejects a role denied by §10.2 (Operator → team.manage) with 403', () => {
    const guard = guardWith('team.manage');
    expect(() =>
      guard.canActivate(contextWith({ role: 'OPERATOR' })),
    ).toThrow(ForbiddenException);
  });

  it('deny rows reject even the Owner (credentials.read, dlq.replay)', () => {
    for (const key of ['credentials.read', 'dlq.replay'] as const) {
      const guard = guardWith(key);
      expect(() =>
        guard.canActivate(contextWith({ role: 'OWNER' })),
      ).toThrow(ForbiddenException);
    }
  });

  it('requires a session (runs after SessionGuard)', () => {
    const guard = guardWith('team.manage');
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('read-only (R) roles do not pass the full-permission check', () => {
    const guard = guardWith('rules.edit'); // Viewer has R, not ✓
    expect(() =>
      guard.canActivate(contextWith({ role: 'VIEWER' })),
    ).toThrow(ForbiddenException);
    expect(guard.canActivate(contextWith({ role: 'OPERATOR' }))).toBe(true);
  });
});
