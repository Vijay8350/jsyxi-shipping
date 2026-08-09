import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { SessionService } from '../../auth/session.service';
import { SESSION_COOKIE, SessionContext } from '../../auth/session.types';

/**
 * The browser-facing surface of the Shopify entry flow (§9.1.1).
 *
 * The rest of the app is a JSON API; these two routes exist because the OAuth
 * loop has to terminate somewhere a browser can land:
 *
 *   GET /       — the app URL Shopify opens. With `?shop=` and no session it
 *                 starts OAuth; with a session it renders the connected state.
 *   GET /entry  — the redirect target of `oauth.controller` callback. It
 *                 exchanges the short-lived entry token for the session cookie
 *                 by POSTing to /auth/shopify-entry, then lands on `/`.
 *
 * The entry token is read from `location.search` in the browser and never
 * interpolated into the served HTML, so there is no reflection sink here.
 * NO_ACCESS (§9.1.2) is surfaced as itself, not flattened into a generic error.
 */
@Controller()
export class AppSurfaceController {
  constructor(private readonly sessions: SessionService) {}

  @Get()
  async home(
    @Query('shop') shop: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const session = await this.resolveSession(req);

    // Shopify opens the app URL with ?shop=; no session means "install me".
    if (!session && typeof shop === 'string' && shop.trim() !== '') {
      res.redirect(`/shopify/install?shop=${encodeURIComponent(shop.trim())}`);
      return;
    }

    // With a session, '/' is just the door to the console (§9.22).
    if (session) {
      res.redirect('/app/');
      return;
    }

    res.type('html').send(installPage());
  }

  @Get('entry')
  entry(@Res() res: Response): void {
    res.type('html').send(ENTRY_PAGE);
  }

  private async resolveSession(req: Request): Promise<SessionContext | null> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    return this.sessions.resolve(token);
  }

}

function installPage(): string {
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
 * Exchanges ?token= for the session cookie. Kept dependency-free and inline so
 * it works under the strict transport posture (§5.7 control 2) with no assets.
 */
const ENTRY_PAGE = page(
  'Signing you in…',
  `<h1 id="heading">Signing you in…</h1>
   <p class="lede" id="detail">Exchanging your Shopify entry token.</p>
   <div id="actions"></div>
   <script>
     (function () {
       var heading = document.getElementById('heading');
       var detail = document.getElementById('detail');
       var actions = document.getElementById('actions');
       var token = new URLSearchParams(window.location.search).get('token');

       function fail(title, message) {
         heading.textContent = title;
         detail.textContent = message;
       }

       if (!token) {
         fail('Missing entry token', 'Open the app from your Shopify admin to sign in.');
         return;
       }

       fetch('/auth/shopify-entry', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         credentials: 'same-origin',
         body: JSON.stringify({ token: token })
       }).then(function (res) {
         return res.json().then(function (body) { return { status: res.status, body: body }; });
       }).then(function (r) {
         if (r.status === 200) {
           window.location.replace('/app/');
           return;
         }
         if (r.status === 403 && r.body && r.body.status === 'NO_ACCESS') {
           fail('No access', 'Your Shopify staff account is not authorised for this store yet.');
           if (r.body.accessRequest === 'PENDING') {
             actions.innerHTML = '<p class="note">Your access request is pending review by the store owner.</p>';
           } else {
             actions.innerHTML = '<p class="note">Ask the store owner to grant you access, then open the app again.</p>';
           }
           return;
         }
         fail('Sign-in failed', 'Your entry token is invalid or has expired. Open the app from your Shopify admin to try again.');
       }).catch(function () {
         fail('Sign-in failed', 'Could not reach the server. Please try again.');
       });
     })();
   </script>`,
);

function page(title: string, body: string): string {
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
  dl { display: grid; grid-template-columns: auto 1fr; gap: .5rem 1.5rem; margin: 0 0 1.5rem; }
  dt { opacity: .65; } dd { margin: 0; font-variant-numeric: tabular-nums; }
  form { display: grid; gap: .5rem; }
  label { font-size: .875rem; opacity: .75; }
  input, button { font: inherit; padding: .6rem .75rem; border-radius: .5rem;
                  border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
  input { background: Canvas; color: CanvasText; }
  button { cursor: pointer; border-color: transparent;
           background: color-mix(in srgb, CanvasText 88%, Canvas); color: Canvas; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;',
  );
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
