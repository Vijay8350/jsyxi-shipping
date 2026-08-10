import { describe, expect, it } from 'vitest';
import configuration from '../../src/config/configuration';

/**
 * §10.3 mandates MFA for staff. ADMIN_REQUIRE_TOTP exists so an operator can
 * accept password-only access with the tradeoff understood — but the DEFAULT
 * and every ambiguous value must keep MFA required. A policy flag that fails
 * open is worse than no flag at all.
 */
function policyFor(value: string | undefined): boolean {
  const prev = process.env.ADMIN_REQUIRE_TOTP;
  if (value === undefined) delete process.env.ADMIN_REQUIRE_TOTP;
  else process.env.ADMIN_REQUIRE_TOTP = value;
  try {
    return (configuration() as { admin: { requireTotp: boolean } }).admin.requireTotp;
  } finally {
    if (prev === undefined) delete process.env.ADMIN_REQUIRE_TOTP;
    else process.env.ADMIN_REQUIRE_TOTP = prev;
  }
}

describe('admin MFA policy (§10.3)', () => {
  it('requires TOTP when the variable is unset', () => {
    expect(policyFor(undefined)).toBe(true);
  });

  it('requires TOTP for every value except an explicit false', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', '', 'off', 'no', 'False!']) {
      expect(policyFor(v), `ADMIN_REQUIRE_TOTP=${JSON.stringify(v)} must keep MFA on`).toBe(true);
    }
  });

  it('only an explicit false opts out, case-insensitively', () => {
    expect(policyFor('false')).toBe(false);
    expect(policyFor('FALSE')).toBe(false);
    expect(policyFor('False')).toBe(false);
  });
});
