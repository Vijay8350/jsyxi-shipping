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

/**
 * OVR-1 native sign-in. A shop's team members each hold their own credentials
 * rather than sharing the Shopify staff entry, so this is a second door into
 * the same console — the session it mints is identical, and §10.2 role checks
 * apply exactly as they do to a Shopify-staff session.
 *
 * Login is shop-scoped (INV-1), so the store domain is part of the form: the
 * same email may legitimately be a member of more than one shop.
 */
export function nativeLoginPage(): string {
  return page(
    'Sign in — Jsyxi Shipping',
    `<h1>Sign in</h1>
     <p class="lede">For team members with their own Jsyxi credentials.</p>
     <form id="f">
       <label for="shop">Store domain</label>
       <input id="shop" name="shop" type="text" required autocomplete="organization"
              placeholder="your-store.myshopify.com" />
       <label for="email">Email</label>
       <input id="email" name="email" type="email" required autocomplete="username" />
       <label for="password">Password</label>
       <input id="password" name="password" type="password" required autocomplete="current-password" />
       <label for="code">Authenticator code <span class="note">(if set up)</span></label>
       <input id="code" name="code" inputmode="numeric" maxlength="6" placeholder="123456"
              autocomplete="one-time-code" />
       <button type="submit">Sign in</button>
     </form>
     <p class="note" id="msg"></p>
     <p class="note">Store owners sign in through Shopify — <a href="/">install or open the app</a>.</p>
     <script>
       document.getElementById('f').addEventListener('submit', function (e) {
         e.preventDefault();
         var btn = e.target.querySelector('button');
         var msg = document.getElementById('msg');
         btn.disabled = true; btn.textContent = 'Signing in…'; msg.textContent = '';
         var body = {
           shopDomain: document.getElementById('shop').value.trim(),
           email: document.getElementById('email').value.trim(),
           password: document.getElementById('password').value
         };
         var code = document.getElementById('code').value.trim();
         if (code) body.totpCode = code;
         fetch('/auth/native/login', {
           method: 'POST', credentials: 'same-origin',
           headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
         }).then(function (r) {
           return r.json().catch(function () { return {}; }).then(function (b) {
             if (!r.ok) throw new Error(b.message || b.status || 'Sign-in failed');
             return b;
           });
         }).then(function () { window.location.replace('/app/'); })
           .catch(function (err) {
             btn.disabled = false; btn.textContent = 'Sign in';
             msg.textContent = err.message;
           });
       });
     </script>`,
  );
}

/**
 * Invite acceptance: the invitee chooses their own password, which is the
 * moment their separate identity comes into existence. The token is read from
 * the query string in the browser and never interpolated into the HTML.
 */
export function acceptInvitePage(): string {
  return page(
    'Accept your invitation — Jsyxi Shipping',
    `<h1>Set your password</h1>
     <p class="lede">You have been invited to a Jsyxi Shipping account. Choose a
     password to finish setting up your own sign-in.</p>
     <form id="f">
       <label for="password">Password</label>
       <input id="password" name="password" type="password" required minlength="12"
              autocomplete="new-password" />
       <label for="confirm">Confirm password</label>
       <input id="confirm" name="confirm" type="password" required minlength="12"
              autocomplete="new-password" />
       <button type="submit">Create my sign-in</button>
     </form>
     <p class="note" id="msg"></p>
     <script>
       document.getElementById('f').addEventListener('submit', function (e) {
         e.preventDefault();
         var msg = document.getElementById('msg');
         var pw = document.getElementById('password').value;
         if (pw !== document.getElementById('confirm').value) {
           msg.textContent = 'The two passwords do not match.'; return;
         }
         var token = new URLSearchParams(window.location.search).get('token');
         if (!token) { msg.textContent = 'This invitation link is incomplete.'; return; }
         var btn = e.target.querySelector('button');
         btn.disabled = true; btn.textContent = 'Setting up…'; msg.textContent = '';
         fetch('/auth/native/invites/accept', {
           method: 'POST', credentials: 'same-origin',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ token: token, password: pw })
         }).then(function (r) {
           return r.json().catch(function () { return {}; }).then(function (b) {
             if (!r.ok) throw new Error(b.message || b.status || 'Could not accept the invitation');
             return b;
           });
         }).then(function () {
           // Accept issues a session, but OVR-1 blocks future PASSWORD logins
           // until TOTP is confirmed. Sending them to the console here would
           // work once and then lock them out, so enrolment happens now while
           // the session exists.
           return enrolTotp();
         }).catch(function (err) {
           btn.disabled = false; btn.textContent = 'Create my sign-in';
           msg.textContent = err.message;
         });
       });

       function enrolTotp() {
         return fetch('/auth/native/totp/enroll', {
           method: 'POST', credentials: 'same-origin'
         }).then(function (r) {
           return r.json().catch(function () { return {}; }).then(function (b) {
             if (!r.ok) throw new Error(b.message || 'Could not start two-factor setup');
             return b;
           });
         }).then(function (b) {
           var secret = (String(b.otpauthUri).match(/[?&]secret=([^&]+)/) || [])[1] || '';
           document.querySelector('main').innerHTML =
             '<h1>One more step</h1>' +
             '<p class="lede">Add this to an authenticator app. It is required every ' +
             'time you sign in.</p>' +
             '<p class="note">Key: <code id="sec"></code></p>' +
             '<form id="cf">' +
               '<label for="code">6-digit code</label>' +
               '<input id="code" inputmode="numeric" maxlength="6" required ' +
                 'autocomplete="one-time-code" placeholder="123456" />' +
               '<button type="submit">Finish</button>' +
             '</form><p class="note" id="m2"></p>';
           // textContent, not innerHTML — the secret is data, not markup.
           document.getElementById('sec').textContent = secret;
           document.getElementById('cf').addEventListener('submit', function (ev) {
             ev.preventDefault();
             var b2 = ev.target.querySelector('button');
             var m2 = document.getElementById('m2');
             b2.disabled = true; b2.textContent = 'Checking…'; m2.textContent = '';
             fetch('/auth/native/totp/confirm', {
               method: 'POST', credentials: 'same-origin',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ code: document.getElementById('code').value.trim() })
             }).then(function (r) {
               if (!r.ok) {
                 return r.json().catch(function () { return {}; }).then(function (b3) {
                   throw new Error(b3.message || 'That code was not accepted');
                 });
               }
               window.location.replace('/app/');
             }).catch(function (e) {
               b2.disabled = false; b2.textContent = 'Finish';
               m2.textContent = e.message;
             });
           });
         });
       }
     </script>`,
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
