import { AuthSource, MemberRole } from '../../auth/session.types';

/** shop_member row (§2.1, migration 0002). */
export interface ShopMemberRow {
  member_id: string;
  shop_id: string;
  shopify_staff_user_id: string | null;
  email: string | null;
  auth_source: AuthSource;
  role: MemberRole;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
  last_active_at: string | null;
  version: number;
}

/** access_request row (§2.1, §3.19). */
export type AccessRequestResolution =
  | 'PENDING'
  | 'GRANTED'
  | 'DENIED'
  | 'WITHDRAWN';

export interface AccessRequestRow {
  request_id: string;
  shop_id: string;
  shopify_staff_user_id: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: AccessRequestResolution;
  version: number;
}

/** audit_log row as read back for the §9.1.2 role-change audit trail (§12). */
export interface AuditTrailRow {
  audit_id: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  occurred_at: string;
}

/** Every role except OWNER — a NATIVE member can never be Owner (OVR-1) and
 * ownership only moves via transfer (§9.1.2) or claim. */
export const NON_OWNER_ROLES: readonly MemberRole[] = [
  'OPERATOR',
  'FINANCE',
  'VIEWER',
];

/** PostgreSQL unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
