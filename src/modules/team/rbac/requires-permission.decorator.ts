import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from './permissions';

export const PERMISSION_KEY = 'team:required_permission';

/**
 * Declares the §10.2 permission an endpoint requires. Enforced by RolesGuard,
 * which must run after SessionGuard (it reads req.session.role).
 *
 *   @RequiresPermission('team.manage')
 */
export const RequiresPermission = (key: PermissionKey) =>
  SetMetadata(PERMISSION_KEY, key);
