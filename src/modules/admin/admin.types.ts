import { Request } from 'express';

/**
 * §10.3 admin roles (admin.jsyxi.com), verbatim:
 *   PLATFORM_ADMIN   — full Courier Master, plans, feature flags, DLQ replay, announcements
 *   SUPPORT_AGENT    — ticket inbox, merchant context, support context (read-only), announcements read
 *   PLATFORM_FINANCE — plan/tier management and billing reconciliation
 */
export type AdminRole = 'PLATFORM_ADMIN' | 'SUPPORT_AGENT' | 'PLATFORM_FINANCE';

export const ALL_ADMIN_ROLES: readonly AdminRole[] = [
  'PLATFORM_ADMIN',
  'SUPPORT_AGENT',
  'PLATFORM_FINANCE',
];

/** The resolved admin identity attached to every admin request. */
export interface AdminContext {
  sessionId: string;
  adminId: string;
  role: AdminRole;
}

/** A live (unexpired, un-ended) support context (A1-07, §10.3). */
export interface SupportContextInfo {
  contextId: string;
  shopId: string;
  adminId: string;
  ticketId: string | null;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
}

export interface AdminAuthenticatedRequest extends Request {
  admin: AdminContext;
}

export interface SupportContextRequest extends AdminAuthenticatedRequest {
  supportContext: SupportContextInfo;
}
