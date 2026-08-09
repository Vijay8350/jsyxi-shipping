import { Injectable } from '@nestjs/common';

/**
 * Pluggable CAPTCHA verifier behind S-38's escalation (§7.6, §9.16).
 *
 * The real provider (Turnstile/reCAPTCHA — an admin decision) slots in by
 * binding CAPTCHA_VERIFIER to a provider implementation; the module default
 * is DevPassCaptchaVerifier, which accepts any non-empty token so dev and
 * tests can exercise the gate without an external call.
 */

export interface CaptchaVerifier {
  /** Returns true when the token proofs a human solved the challenge. */
  verify(token: string, ipHash: string): Promise<boolean>;
}

export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

@Injectable()
export class DevPassCaptchaVerifier implements CaptchaVerifier {
  async verify(token: string): Promise<boolean> {
    return typeof token === 'string' && token.trim().length > 0;
  }
}
