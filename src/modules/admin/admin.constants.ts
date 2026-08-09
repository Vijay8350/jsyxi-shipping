/**
 * Admin panel (§9.13, §10.3) policy constants.
 *
 * §10.3 requires MFA-backed RBAC for admin staff and a time-limited support
 * context but names no numbers; the values below are this module's choices,
 * named here so a later settings pass can move them without touching logic.
 */

/** Admin session cookie name — separate from the merchant jsyxi_session cookie. */
export const ADMIN_SESSION_COOKIE = 'jsyxi_admin_session';

/** Admin session TTL: 12 hours, matching the merchant session TTL (RW-04). */
export const ADMIN_SESSION_TTL_HOURS = 12;

/** Minimum admin password length (same policy as OVR-1 native members). */
export const ADMIN_PASSWORD_MIN_LENGTH = 12;

/** TOTP verification tolerance: ±1 30-second step for clock drift. */
export const ADMIN_TOTP_WINDOW = 1;

/** Issuer label in otpauth:// URIs for the admin console. */
export const ADMIN_TOTP_ISSUER = 'Jsyxi Admin';

/**
 * A1-07 / §10.3: a support context is time-limited. 60 minutes is the hard
 * ceiling; the opener may ask for less, never more.
 */
export const SUPPORT_CONTEXT_MAX_MINUTES = 60;
export const SUPPORT_CONTEXT_DEFAULT_MINUTES = 30;

/** ADD-32 booking failure monitor default window. */
export const BOOKING_FAILURE_WINDOW_MINUTES = 360;
export const BOOKING_FAILURE_SPIKE_HOURS = 24;

/** §9.13 courier API error monitor default window. */
export const COURIER_API_MONITOR_HOURS = 24;
