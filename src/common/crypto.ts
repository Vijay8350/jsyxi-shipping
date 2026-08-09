import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * HMAC helpers for Shopify webhook verification (§8.1), the signed entry
 * token (§9.1.1, §5.7 control 6) and salted PII correlation hashes
 * (§5.7 control 4, ADD-24).
 */

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacSha256Base64(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64');
}

/** Constant-time comparison; mismatched input is simply false, never thrown. */
export function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function safeEqualBase64(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'base64');
    const bb = Buffer.from(b, 'base64');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** SHA-256 hash of a token for at-rest storage (tokens are never stored raw). */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Salted hash for PII that must be correlated but never stored or logged raw
 * (§5.7 control 4). The value is NFC-normalized and case-folded first (RW-13).
 */
export function saltedPiiHash(salt: string, value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase();
  return createHmac('sha256', salt).update(normalized).digest('hex');
}
