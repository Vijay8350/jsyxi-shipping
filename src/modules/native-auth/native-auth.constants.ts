/**
 * OVR-1 native-auth policy constants.
 *
 * OVR-1 requires password reset, lockout after failed attempts, a 12h session
 * TTL (RW-04, owned by SessionService) and full audit of every native login,
 * but names no numbers. The values below are the module's choices, named here
 * so a later settings pass can move them without touching logic.
 */

/** Hours an Owner-issued invite stays valid before it expires. */
export const INVITE_TTL_HOURS = 72;

/** Minimum native password length (OVR-1 adds passwords; policy is ours). */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Failed-attempt lockout (OVR-1). After LOCK_THRESHOLD consecutive bad
 * passwords the credential locks for LOCK_MINUTES minutes. TOTP failures do
 * not feed the counter — an attacker without the password never reaches the
 * TOTP step, and counting TOTP failures would let a leaked password lock the
 * real member out.
 */
export const LOCK_THRESHOLD = 5;
export const LOCK_MINUTES = 15;

/** Minutes a magic-link login token stays valid (single use, OVR-1). */
export const MAGIC_LINK_TTL_MINUTES = 15;

/** Hours a password-reset token stays valid (OVR-1). */
export const PASSWORD_RESET_TTL_HOURS = 1;

/** TOTP verification tolerance: ±1 30-second step for clock drift. */
export const TOTP_WINDOW = 1;

/** Issuer label in otpauth:// URIs (what the authenticator app shows). */
export const TOTP_ISSUER = 'Jsyxi';
