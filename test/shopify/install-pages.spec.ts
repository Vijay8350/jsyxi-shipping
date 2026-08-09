import { describe, expect, it } from 'vitest';
import { installErrorPage, installPage } from '../../src/modules/shopify/install-pages';

/**
 * These pages are reached by browser redirect from Shopify, so what they return
 * is read by a merchant. The contract under test is that a failure explains
 * itself and offers a next step — not that it names a code.
 */
describe('installErrorPage (§9.1.1 browser-facing failures)', () => {
  it('renders HTML, not a JSON body', () => {
    const html = installErrorPage('CURRENCY_NOT_INR', 'raw message');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('{"error"');
  });

  it('INV-2: tells the merchant how to fix the currency and that nothing was saved', () => {
    const html = installErrorPage('CURRENCY_NOT_INR', 'raw message');
    expect(html).toContain('not set to INR');
    // The actionable part: where to go in Shopify.
    expect(html).toContain('Settings → General');
    expect(html).toContain('Indian Rupee');
    // Reassurance matters here — a blocked install must not imply a half-write.
    expect(html).toContain('Nothing was');
    // And a way back without hunting for the install link again.
    expect(html).toContain('action="/shopify/install"');
  });

  it('does not offer a retry when retrying cannot help (§9.1.2 escalation)', () => {
    const html = installErrorPage('STAFF_IDENTITY_UNAVAILABLE', 'raw message');
    expect(html).toContain('Shopify did not identify you');
    expect(html).toContain('Contact support');
    // Telling someone to retry something that cannot succeed wastes their time.
    expect(html).not.toContain('Try the install again');
  });

  it('offers a retry for the transient and single-use failures', () => {
    for (const code of ['BAD_STATE', 'BAD_HMAC', 'TOKEN_EXCHANGE_FAILED', 'SHOPIFY_API']) {
      expect(installErrorPage(code, 'x')).toContain('Try the install again');
    }
  });

  it('still shows the machine code so support can be precise', () => {
    expect(installErrorPage('BAD_HMAC', 'x')).toContain('BAD_HMAC');
  });

  it('falls back usefully for a code it has no copy for', () => {
    const html = installErrorPage('SOMETHING_NEW', 'the underlying message');
    expect(html).toContain('could not be completed');
    expect(html).toContain('the underlying message');
    expect(html).toContain('SOMETHING_NEW');
  });

  it('escapes the code and message rather than interpolating them raw', () => {
    const html = installErrorPage('<img src=x onerror=alert(1)>', '"><script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img');
  });
});

describe('installPage', () => {
  it('asks for a myshopify domain and posts to the install route', () => {
    const html = installPage();
    expect(html).toContain('action="/shopify/install"');
    expect(html).toContain('myshopify.com');
  });
});
