/**
 * The handful of browser-facing pages in the install flow.
 *
 * These routes are reached by REDIRECT from Shopify, not by fetch, so whatever
 * they return is rendered directly to a merchant. Answering a browser
 * navigation with a raw JSON error body is a dead end: it names a condition the
 * merchant cannot act on and gives them nowhere to go.
 *
 * Kept dependency-free and self-contained — no assets, no external requests —
 * so they render under the §5.7 control 2 transport posture and before the
 * console's static bundle is relevant.
 */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;',
  );
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.55 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background: Canvas; color: CanvasText; }
  main { width: min(34rem, 92vw); padding: 2.5rem 0; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  .lede { margin: 0 0 1.5rem; opacity: .75; }
  .note { font-size: .875rem; opacity: .7; }
  ol { padding-left: 1.1rem; margin: 0 0 1.5rem; }
  li { margin: .35rem 0; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .875em;
         background: color-mix(in srgb, CanvasText 8%, transparent);
         padding: .1rem .35rem; border-radius: .25rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .5rem 1.5rem; margin: 0 0 1.5rem; }
  dt { opacity: .65; } dd { margin: 0; }
  form { display: grid; gap: .5rem; }
  label { font-size: .875rem; opacity: .75; }
  input, button { font: inherit; padding: .6rem .75rem; border-radius: .5rem;
                  border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
  input { background: Canvas; color: CanvasText; }
  button { cursor: pointer; border-color: transparent;
           background: color-mix(in srgb, CanvasText 88%, Canvas); color: Canvas; }
  .bad { border-left: 3px solid #c2410c; padding-left: .9rem; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function installPage(): string {
  return page(
    'Install Jsyxi Shipping',
    `<h1>Install Jsyxi Shipping</h1>
     <p class="lede">Enter your store domain to begin the Shopify install.</p>
     <form method="get" action="/shopify/install">
       <label for="shop">Store domain</label>
       <input id="shop" name="shop" type="text" required
              placeholder="your-store.myshopify.com"
              pattern="[a-zA-Z0-9][a-zA-Z0-9-]*\\.myshopify\\.com" />
       <button type="submit">Install</button>
     </form>`,
  );
}

interface ErrorCopy {
  title: string;
  lede: string;
  /** What the merchant can actually do about it. */
  steps?: string[];
  /** True when retrying the install is the right next move. */
  retry?: boolean;
}

/**
 * Merchant-facing copy per failure. The distinction that matters is whether
 * the merchant can fix it themselves (currency, domain) or whether it needs
 * someone else (staff identity, Shopify outage) — telling someone to "try
 * again" when retrying cannot possibly work wastes their time.
 */
const COPY: Record<string, ErrorCopy> = {
  CURRENCY_NOT_INR: {
    title: 'This store is not set to INR',
    lede:
      'Jsyxi Shipping books shipments with Indian couriers and settles in rupees, ' +
      'so it can only be installed on a store whose currency is INR. Nothing was ' +
      'saved and your store was not changed.',
    steps: [
      'In Shopify admin, open Settings → General.',
      'Under Store defaults, change Store currency to Indian Rupee (INR).',
      'Come back and install again.',
    ],
    retry: true,
  },
  INVALID_SHOP_DOMAIN: {
    title: 'That does not look like a Shopify store',
    lede: 'The install link must carry a myshopify.com domain.',
    steps: ['Install from your Shopify admin, or enter your full <code>your-store.myshopify.com</code> domain.'],
    retry: true,
  },
  BAD_HMAC: {
    title: 'This install link could not be verified',
    lede:
      'The signature on the link did not match, so it was refused. This happens ' +
      'when a link is edited, forwarded, or has already been used.',
    steps: ['Start the install again from your Shopify admin.'],
    retry: true,
  },
  BAD_STATE: {
    title: 'This install link has expired',
    lede: 'Install links are single-use and valid for ten minutes.',
    steps: ['Start the install again from your Shopify admin.'],
    retry: true,
  },
  STAFF_IDENTITY_UNAVAILABLE: {
    title: 'Shopify did not identify you',
    lede:
      'Jsyxi Shipping records who books every shipment, so it will not fall back ' +
      'to shop-wide access. Your store was connected, but no one has been given ' +
      'access yet.',
    steps: ['Contact support — this needs to be resolved on our side, not yours.'],
  },
  TOKEN_EXCHANGE_FAILED: {
    title: 'Could not complete the handshake with Shopify',
    lede: 'Shopify did not return an access token. This is usually temporary.',
    steps: ['Wait a moment and start the install again.'],
    retry: true,
  },
  SHOPIFY_API: {
    title: 'Shopify did not respond',
    lede: 'We could not read your store details. This is usually temporary.',
    steps: ['Wait a moment and start the install again.'],
    retry: true,
  },
};

/**
 * Renders an install failure as a page a merchant can act on. The machine
 * code is still shown, quietly, so a support conversation can be precise.
 */
export function installErrorPage(code: string, message: string): string {
  const copy: ErrorCopy = COPY[code] ?? {
    title: 'The install could not be completed',
    lede: message,
    steps: ['Start the install again from your Shopify admin.'],
    retry: true,
  };

  const steps = copy.steps?.length
    ? `<ol>${copy.steps.map((s) => `<li>${s}</li>`).join('')}</ol>`
    : '';

  const retry = copy.retry
    ? `<form method="get" action="/shopify/install">
         <label for="shop">Store domain</label>
         <input id="shop" name="shop" type="text" required
                placeholder="your-store.myshopify.com"
                pattern="[a-zA-Z0-9][a-zA-Z0-9-]*\\.myshopify\\.com" />
         <button type="submit">Try the install again</button>
       </form>`
    : '';

  return page(
    copy.title,
    `<div class="bad">
       <h1>${escapeHtml(copy.title)}</h1>
       <p class="lede">${escapeHtml(copy.lede)}</p>
     </div>
     ${steps}
     ${retry}
     <p class="note">Reference: <code>${escapeHtml(code)}</code></p>`,
  );
}
