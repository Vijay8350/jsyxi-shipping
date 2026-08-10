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

function contextWith(
  session?: Partial<SessionContext>,
  method?: string,
): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ session, method }),
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

  it('read-only (R) roles may READ but not WRITE (§10.2 R vs ✓)', () => {
    const guard = guardWith('rules.edit'); // Viewer has R, Operator has ✓
    // R means readable: denying this locked Viewer out of the product, since
    // it holds R and nothing else.
    expect(guard.canActivate(contextWith({ role: 'VIEWER' }, 'GET'))).toBe(true);
    expect(guard.canActivate(contextWith({ role: 'VIEWER' }, 'HEAD'))).toBe(true);
    // …but never writable.
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() =>
        guard.canActivate(contextWith({ role: 'VIEWER' }, m)),
      ).toThrow(ForbiddenException);
    }
    expect(guard.canActivate(contextWith({ role: 'OPERATOR' }, 'POST'))).toBe(true);
  });

  it('treats an unknown method as a write — the guard fails safe', () => {
    const guard = guardWith('rules.edit');
    expect(() =>
      guard.canActivate(contextWith({ role: 'VIEWER' })),
    ).toThrow(ForbiddenException);
  });

  it('a deny row (—) rejects every role, Owner included, on reads too', () => {
    const guard = guardWith('credentials.read');
    for (const role of ['OWNER', 'OPERATOR', 'FINANCE', 'VIEWER'] as const) {
      expect(() =>
        guard.canActivate(contextWith({ role }, 'GET')),
      ).toThrow(ForbiddenException);
    }
  });
});
