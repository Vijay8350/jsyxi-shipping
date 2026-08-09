import { SetMetadata } from '@nestjs/common';
import { AdminRole } from './admin.types';

export const ADMIN_ROLES_KEY = 'jsyxi_admin_roles';

/**
 * §10.3 per-endpoint role enforcement. Absence of this decorator on an
 * admin route means PLATFORM_ADMIN only (deny-by-default, matching §9.1.2's
 * structural stance — an unannotated admin route is never silently open).
 */
export const AdminRoles = (...roles: AdminRole[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
