/**
 * Session types (RW-04, OVR-1). A session is always bound to BOTH
 * (shop_id, member_id) — INV-1 is unchanged by OVR-1's second entry path.
 */

export type MemberRole = 'OWNER' | 'OPERATOR' | 'FINANCE' | 'VIEWER';
export type AuthSource = 'SHOPIFY_STAFF' | 'NATIVE';

export interface SessionContext {
  sessionId: string;
  shopId: string;
  memberId: string;
  role: MemberRole;
  authSource: AuthSource;
}

export const SESSION_COOKIE = 'jsyxi_session';

export type InvalidateReason =
  | 'LOGOUT'
  | 'UNINSTALL'
  | 'SHOPIFY_ACCESS_REVOKED'
  | 'ROLE_REVOKED'
  | 'OWNER_TRANSFER'
  | 'MEMBER_REVOKED'
  | 'PASSWORD_RESET';
