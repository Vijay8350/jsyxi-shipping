/**
 * Server-rendered HTML shells and the merchant snippet (§9.16).
 *
 * Deliberately thin: the design system lands with the frontend. These
 * templates exist so the two public URLs render something usable today —
 * the JSON contract (track-page.types.ts) is what the real frontend will
 * consume. Inline template strings only, no framework. Every interpolated
 * value is HTML-escaped.
 */

import { TrackPageBranding, TrackShipmentPageData } from './track-page.types';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseStyles(branding: TrackPageBranding): string {
  const dark = branding.theme === 'dark';
  return `
    body{font-family:Inter,system-ui,sans-serif;margin:0;padding:2rem;
      background:${dark ? '#10181a' : '#f7f9f9'};color:${dark ? '#e8eeee' : '#14212b'};}
    .card{max-width:640px;margin:0 auto;background:${dark ? '#182527' : '#fff'};
      border-radius:12px;padding:1.5rem;box-shadow:0 1px 4px rgba(0,0,0,.12);}
    button{background:${escapeHtml(branding.buttonColour)};color:#fff;border:0;
      border-radius:8px;padding:.6rem 1.2rem;font-size:1rem;cursor:pointer;}
    input{display:block;width:100%;box-sizing:border-box;margin:.35rem 0 1rem;
      padding:.55rem;border:1px solid #9fb3b3;border-radius:8px;font-size:1rem;}
    label{font-size:.9rem;font-weight:600;}
    .event{border-left:3px solid ${escapeHtml(branding.buttonColour)};
      padding:.3rem 0 .3rem .8rem;margin:.6rem 0;}
    .muted{opacity:.65;font-size:.85rem;}
    .err{color:#b3261e;}
  `;
}

function page(title: string, branding: TrackPageBranding, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${baseStyles(branding)}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

/** Hosted lookup page at GET /track/:shopRef — the S-31/S-32 form. */
export function renderLookupShell(
  shopRef: string,
  branding: TrackPageBranding,
  error?: string,
): string {
  if (error) {
    return page('Track your order', branding, `<h1>Track your order</h1><p class="err">${escapeHtml(error)}</p>`);
  }
  return page(
    'Track your order',
    branding,
    `<h1>Track your order</h1>
<form id="f">
  <label for="identifier">${escapeHtml(branding.orderBoxLabel)}</label>
  <input id="identifier" name="identifier" required autocomplete="off">
  <label for="contact">${escapeHtml(branding.contactBoxLabel)}</label>
  <input id="contact" name="contact" required autocomplete="off">
  <div id="captcha" hidden>
    <label for="captchaToken">Verification</label>
    <input id="captchaToken" name="captchaToken" autocomplete="off">
  </div>
  <button type="submit">Track</button>
</form>
<div id="result"></div>
<script>
// Prefill the identifier when arriving from the store-page snippet (the
// snippet never carries the contact value — phone/email stay out of URLs).
document.getElementById('identifier').value =
  new URLSearchParams(location.search).get('identifier') || '';
document.getElementById('f').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var body = {
    shopRef: ${JSON.stringify(shopRef)},
    identifier: document.getElementById('identifier').value,
    contact: document.getElementById('contact').value
  };
  var ct = document.getElementById('captchaToken');
  if (ct && ct.value) body.captchaToken = ct.value;
  var res = await fetch('/track/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  var data = await res.json();
  var out = document.getElementById('result');
  if (data.ok) {
    out.innerHTML = data.shipments.map(function (s) {
      return '<h3>' + (s.awb || 'Shipment') + (s.isTest ? ' (TEST)' : '') + '</h3>' +
        '<p>Status: ' + s.status + '</p>' +
        s.timeline.map(function (e) {
          return '<div class="event"><div>' + (e.status || e.rawStatus) + '</div>' +
            '<div class="muted">' + e.occurredAt + (e.locationText ? ' · ' + e.locationText : '') + '</div></div>';
        }).join('');
    }).join('<hr>');
  } else {
    if (data.captchaRequired) document.getElementById('captcha').hidden = false;
    out.innerHTML = '<p class="err"></p>';
    out.querySelector('p').textContent = data.error;
  }
});
</script>`,
  );
}

/** Tokenized-link page at GET /track/t/:token — one shipment's timeline. */
export function renderTokenShell(
  branding: TrackPageBranding,
  shipment: TrackShipmentPageData | null,
  error?: string,
): string {
  if (error || !shipment) {
    return page('Track your order', branding, `<h1>Track your order</h1><p class="err">${escapeHtml(error ?? 'This tracking link is no longer valid.')}</p>`);
  }
  const events = shipment.timeline
    .map(
      (e) =>
        `<div class="event"><div>${escapeHtml(e.status ?? e.rawStatus)}</div>` +
        `<div class="muted">${escapeHtml(e.occurredAt)}${e.locationText ? ' · ' + escapeHtml(e.locationText) : ''}</div>` +
        `${e.reasonText ? `<div class="muted">${escapeHtml(e.reasonText)}</div>` : ''}</div>`,
    )
    .join('');
  const items =
    shipment.items && shipment.items.length > 0
      ? `<h3>Items</h3><ul>${shipment.items
          .map((i) => `<li>${escapeHtml(i.title ?? 'Item')}${i.variant ? ' — ' + escapeHtml(i.variant) : ''} × ${i.quantity}</li>`)
          .join('')}</ul>`
      : '';
  return page(
    'Track your order',
    branding,
    `<h1>Track your order${shipment.isTest ? ' (TEST)' : ''}</h1>
<p>Status: <strong>${escapeHtml(shipment.status)}</strong></p>
${shipment.awb ? `<p class="muted">AWB ${escapeHtml(shipment.awb)}</p>` : ''}
${shipment.courierName ? `<p class="muted">via ${escapeHtml(shipment.courierName)}</p>` : ''}
${shipment.edd && (shipment.edd.from || shipment.edd.to) ? `<p>Expected delivery: ${escapeHtml(shipment.edd.from ?? '')}${shipment.edd.to ? ' – ' + escapeHtml(shipment.edd.to) : ''}</p>` : ''}
${items}
<h3>Timeline</h3>${events || '<p class="muted">No tracking events yet.</p>'}`,
  );
}

/**
 * The "Generate code" snippet (§9.16): an embeddable fragment the merchant
 * pastes as a Shopify store page. It renders the S-31/S-32 lookup form and
 * posts to the hosted lookup endpoint, linking through to the hosted page.
 */
export function renderSnippet(
  shopRef: string,
  hostedPageUrl: string,
  branding: TrackPageBranding,
): string {
  return `<!-- Jsyxi Shipping — Track-Order page snippet (§9.16). Paste into a Shopify store page. -->
<div id="jsyxi-track" style="max-width:560px;margin:0 auto;font-family:Inter,system-ui,sans-serif;">
  <form id="jsyxi-track-form">
    <label for="jsyxi-identifier" style="display:block;font-weight:600;">${escapeHtml(branding.orderBoxLabel)}</label>
    <input id="jsyxi-identifier" required style="display:block;width:100%;box-sizing:border-box;margin:.35rem 0 1rem;padding:.55rem;border:1px solid #9fb3b3;border-radius:8px;">
    <label for="jsyxi-contact" style="display:block;font-weight:600;">${escapeHtml(branding.contactBoxLabel)}</label>
    <input id="jsyxi-contact" required style="display:block;width:100%;box-sizing:border-box;margin:.35rem 0 1rem;padding:.55rem;border:1px solid #9fb3b3;border-radius:8px;">
    <button type="submit" style="background:${escapeHtml(branding.buttonColour)};color:#fff;border:0;border-radius:8px;padding:.6rem 1.2rem;cursor:pointer;">Track</button>
  </form>
  <p id="jsyxi-track-result" style="margin-top:1rem;"></p>
</div>
<script>
(function () {
  var shopRef = ${JSON.stringify(shopRef)};
  var hostedPage = ${JSON.stringify(hostedPageUrl)};
  document.getElementById('jsyxi-track-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    // The hosted page owns verification, throttling (S-38) and rendering.
    // Only the identifier rides in the URL; the contact value (phone/email)
    // is re-entered on the hosted page and never appears in a URL (§5.7.4).
    var identifier = document.getElementById('jsyxi-identifier').value;
    window.location.href = hostedPage + '?identifier=' + encodeURIComponent(identifier);
  });
})();
</script>`;
}
