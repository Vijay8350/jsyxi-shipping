import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Surface scans (no runtime behaviour here — these read sources):
 *
 * 1. INV-23: the ONLY Shopify charge paths in the entire codebase are the
 *    Billing API mutations in src/modules/billing/shopify-billing.client.ts
 *    (appSubscriptionCreate / appUsageRecordCreate / appSubscriptionCancel).
 *    No other file may name a charge mutation, and no money column beyond
 *    subscription + usage_record + overage_credit may exist in this module.
 * 2. §3.11 capability ladder: the query-level guards in booking, auto-ship
 *    and labels read shop.account_state and block RESTRICTED / READ_ONLY /
 *    UNINSTALLED — this module writes that state, they enforce it.
 */

const SRC = join(__dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALL_SOURCES = walk(SRC).map((path) => ({
  path,
  content: readFileSync(path, 'utf8'),
}));

describe('INV-23: the subscription + AWB overage are the only money charged', () => {
  const CHARGE_MUTATIONS = [
    'appSubscriptionCreate',
    'appUsageRecordCreate',
    'appSubscriptionCancel',
  ];

  it('charge mutations exist only in the billing Shopify client', () => {
    for (const { path, content } of ALL_SOURCES) {
      const isBillingClient = path.includes(
        join('billing', 'shopify-billing.client.ts'),
      );
      for (const mutation of CHARGE_MUTATIONS) {
        // GraphQL document definitions and mutation-field references.
        const occurrences =
          content.split(mutation).length - 1 -
          // The client's own comment/doc mentions are fine; count code uses:
          (isBillingClient ? 0 : 0);
        if (isBillingClient) continue;
        expect(
          occurrences,
          `${mutation} found outside shopify-billing.client.ts: ${path}`,
        ).toBe(0);
      }
    }
  });

  it('no other Shopify money mutation exists anywhere (charge/createCharge/payment)', () => {
    const FORBIDDEN = [
      'appPurchaseOneTimeCreate',
      'appPurchaseOneTime',
      'appCreditCreate',
      'appRefundCreate',
      'shopifyPayments',
    ];
    for (const { path, content } of ALL_SOURCES) {
      for (const term of FORBIDDEN) {
        expect(content.includes(term), `${term} found in ${path}`).toBe(false);
      }
    }
  });

  it('the billing module holds no balance/wallet/payout/margin column or write', () => {
    const billingDir = join(SRC, 'modules', 'billing');
    for (const path of walk(billingDir)) {
      const content = readFileSync(path, 'utf8');
      // Column/identifier-level scan: these words may appear in comments
      // ("no wallet") but never as SQL columns or code identifiers.
      expect(/\b(wallet|balance|payout|margin)(_id|\s*[:=])/i.test(content)).toBe(
        false,
      );
      expect(/INSERT INTO (?!usage_record|overage_credit)\w*(ledger|account|wallet)/i.test(content)).toBe(false);
    }
  });
});

describe('§3.11 capability ladder: sibling guards read account_state', () => {
  const STOP_LIST_GUARDS = [
    join('booking', 'booking.service.ts'), // new booking stops
    join('booking-ops', 'auto-ship.service.ts'), // auto-ship stops
    join('labels', 'labels.service.ts'), // new label generation stops
    join('labels', 'bulk-labels.service.ts'),
  ];

  for (const rel of STOP_LIST_GUARDS) {
    it(`${rel} blocks RESTRICTED / READ_ONLY / UNINSTALLED`, () => {
      const full = join(SRC, 'modules', rel);
      const content = readFileSync(full, 'utf8');
      // Reads shop.account_state (the state this module writes) …
      expect(content).toContain('account_state');
      // … and the blocked set covers all three non-live states.
      expect(content).toMatch(
        /BLOCKED_ACCOUNT_STATES\s*=\s*new Set\(\['RESTRICTED', 'READ_ONLY', 'UNINSTALLED'\]\)/,
      );
    });
  }

  it('bulk booking inherits the ladder by delegating to BookingService.queueBooking', () => {
    // bulk-booking.service.ts has no account_state read of its own — every
    // bulk order runs through queueBooking, which carries the §3.11 guard
    // asserted above. Assert the delegation so the guard cannot be bypassed.
    const content = readFileSync(
      join(SRC, 'modules', 'booking-ops', 'bulk-booking.service.ts'),
      'utf8',
    );
    expect(content).toContain('this.booking.queueBooking');
  });
});

describe('§9.5.6 booking gate semantics (capped_amount)', () => {
  it('the booking module permits overage only when capped_amount > 0', () => {
    const content = readFileSync(
      join(SRC, 'modules', 'booking', 'booking.service.ts'),
      'utf8',
    );
    expect(content).toContain('capped_amount');
    expect(content).toMatch(/overagePermitted\s*=/);
    expect(content).toMatch(/rupeesToPaise\(sub\.capped_amount\) > 0n/);
    // … and allowance-exceeding bookings surface the approval prompt.
    expect(content).toContain('approvalNeeded');
  });
});
