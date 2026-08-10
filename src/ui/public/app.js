/*
 * Jsyxi Shipping — merchant console.
 *
 * Deliberately dependency-free and build-free: it is served as three static
 * files by the same Nest process that serves the API, so a deploy is one
 * artifact and the t3.micro never runs a frontend build. Routing is
 * hash-based, which means no server catch-all and no 404 on refresh.
 *
 * Auth is the existing `jsyxi_session` cookie — every fetch is same-origin
 * with credentials, and a 401 sends the operator back to the entry flow.
 *
 * §9.23 runs through the whole file: the test/live view is a first-class piece
 * of state, it defaults to live, it is persisted, and every list that can show
 * a test record renders the test marker.
 */
(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────
  var VIEW_KEY = 'jsyxi.view';
  var state = {
    // §9.23: live unless the operator explicitly opted into test.
    view: localStorage.getItem(VIEW_KEY) === 'test' ? 'test' : 'live',
    session: null,
  };

  var root = document.getElementById('root');
  var toastHost = document.getElementById('toasts');

  /* Theme. Follows the OS until the operator picks a side, then that sticks —
     a warehouse screen and a finance laptop rarely want the same one, and the
     OS setting is not always theirs to change. */
  var THEME_KEY = 'jsyxi.theme';
  function applyTheme() {
    var t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  function currentTheme() {
    var stored = localStorage.getItem(THEME_KEY);
    if (stored) return stored;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }
  applyTheme();

  // ─── Utilities ────────────────────────────────────────────────────────
  function h(html) {
    // Single escape helper; every interpolation of server data goes through it.
    return String(html === null || html === undefined ? '' : html)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    if (!isFinite(n)) return h(v);
    return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function num(v) {
    return (Number(v) || 0).toLocaleString('en-IN');
  }

  function dateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function relative(iso) {
    if (!iso) return 'never';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    return Math.round(hrs / 24) + ' d ago';
  }

  /* Domain acronyms must survive title-casing. Naive title case renders COD as
     "Cod" and NDR as "Ndr", which reads as a typo to anyone who works in
     logistics and quietly undermines trust in every other number on screen. */
  var ACRONYMS = {
    COD: 1, NDR: 1, RTO: 1, GST: 1, GSTIN: 1, AWB: 1, SLA: 1, TAT: 1, EDD: 1,
    SKU: 1, HSN: 1, PIN: 1, OTP: 1, API: 1, CSV: 1, PDF: 1, ID: 1, DTDC: 1,
    KYC: 1, QC: 1, ETA: 1,
  };

  function titleCase(s) {
    return String(s || '').split(/[_\s]+/).filter(Boolean).map(function (w) {
      var up = w.toUpperCase();
      if (ACRONYMS[up]) return up;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  }

  function toast(msg, bad) {
    var el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    toastHost.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  // ─── API ──────────────────────────────────────────────────────────────
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) {
        // The session expired (RW-04 12h inactivity) — restart entry.
        window.location.href = '/';
        throw new Error('unauthenticated');
      }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error((body && (body.message || body.status)) || ('HTTP ' + res.status));
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  // ─── Chrome ───────────────────────────────────────────────────────────
  var NAV = [
    { section: 'Operate' },
    { id: '', icon: '◧', label: 'Dashboard' },
    { id: 'orders', icon: '▤', label: 'Orders' },
    { id: 'shipments', icon: '▦', label: 'Shipments' },
    { id: 'ndr', icon: '⚠', label: 'NDR' },
    { section: 'Money' },
    { id: 'invoices', icon: '₹', label: 'GST invoices' },
    { id: 'recon-freight', icon: '⇄', label: 'Freight recon' },
    { id: 'recon-cod', icon: '⊟', label: 'COD recon' },
    { id: 'billing', icon: '◉', label: 'Plan & billing' },
    { section: 'Configure' },
    { id: 'rules', icon: '⑂', label: 'Rules' },
    { id: 'rate-cards', icon: '▥', label: 'Rate cards' },
    { id: 'couriers', icon: '◈', label: 'Couriers' },
    { id: 'reports', icon: '↧', label: 'Reports' },
    { id: 'setup', icon: '✓', label: 'Setup' },
    { id: 'support', icon: '✉', label: 'Support' },
    { id: 'settings', icon: '⚙', label: 'Settings' },
  ];

  function currentRoute() {
    var raw = (window.location.hash || '#/').replace(/^#\/?/, '');
    var parts = raw.split('/');
    return { name: parts[0] || '', arg: parts[1] || null };
  }

  function shell(route) {
    var nav = NAV.map(function (item) {
      if (item.section) return '<div class="nav-sep">' + h(item.section) + '</div>';
      var active = item.id === route.name ? ' active' : '';
      return '<a class="nav-item' + active + '" href="#/' + item.id + '">' +
        '<span class="ico" aria-hidden="true">' + item.icon + '</span>' + h(item.label) + '</a>';
    }).join('');

    var shop = state.session && state.session.shop ? state.session.shop : '';
    var role = state.session && state.session.role ? state.session.role : '';

    return '' +
      '<div class="shell">' +
        '<aside class="sidebar">' +
          '<div class="brand"><span class="brand-mark">J</span>Jsyxi</div>' + nav +
        '</aside>' +
        '<div class="main">' +
          '<header class="topbar">' +
            viewToggle() +
            '<div class="spacer"></div>' +
            (shop ? '<span class="muted" style="font-size:13px">' + h(shop) + '</span>' : '') +
            (role ? '<span class="badge">' + h(titleCase(role)) + '</span>' : '') +
            /* §9.19: the bell is always present so its absence never means
               "no announcements"; the count badge appears only when unread. */
            '<button class="btn sm" id="bell" title="Announcements" aria-label="Announcements"' +
              ' style="position:relative">🔔<span id="bellcount"></span></button>' +
            '<button class="btn sm" id="theme" title="Switch theme" aria-label="Switch theme">' +
              (currentTheme() === 'dark' ? '☀' : '☾') + '</button>' +
            '<button class="btn sm" id="logout">Sign out</button>' +
          '</header>' +
          '<div id="annhost" style="padding:22px 24px 0;max-width:1400px;width:100%"></div>' +
            '<main class="content" id="view"></main>' +
        '</div>' +
      '</div>';
  }

  /* §9.23: the test/live switch, present on every screen so the operator can
     always find their test parcels — and always see which mode they are in. */
  function viewToggle() {
    return '<div class="seg" role="group" aria-label="Test or live data">' +
      '<button data-view="live"' + (state.view === 'live' ? ' class="on"' : '') + '>Live</button>' +
      '<button data-view="test"' + (state.view === 'test' ? ' class="on"' : '') + '>Test</button>' +
      '</div>';
  }

  function testBanner() {
    if (state.view !== 'test') return '';
    return '<div class="banner warn" style="margin-bottom:16px">' +
      '<strong>Test view.</strong>&nbsp;These are test shipments (§9.23). ' +
      'They never reach a courier and never notify a customer.</div>';
  }

  function loading() {
    return '<div class="card"><div class="card-body">' +
      '<div class="skel" style="width:30%"></div>' +
      '<div class="skel" style="width:70%;margin-top:10px"></div>' +
      '<div class="skel" style="width:55%;margin-top:10px"></div>' +
      '</div></div>';
  }

  function errorCard(err) {
    return '<div class="card"><div class="card-body">' +
      '<div class="banner bad"><div><strong>Could not load.</strong><br>' +
      h(err && err.message ? err.message : 'Unknown error') + '</div></div></div></div>';
  }

  function empty(title, sub) {
    return '<div class="empty"><div class="big">' + h(title) + '</div>' +
      '<div>' + h(sub || '') + '</div></div>';
  }

  // ─── Badges ───────────────────────────────────────────────────────────
  /* Tone by real enum label (order_state, booking_state, custody_state,
     movement_state, plus account/health states). Anything unmapped renders
     neutral rather than guessing — a wrong colour on a state is worse than
     no colour, because operators learn the colour before the word. */
  var TONE = {
    // Good / terminal-successful
    DELIVERED: 'ok', CONFIRMED: 'ok', FULLY_BOOKED: 'ok', CLOSED: 'ok',
    ACTIVE: 'ok', CONNECTED: 'ok', READY: 'ok', ISSUED: 'ok', HEALTHY: 'ok',
    IN_CUSTODY: 'ok', ASSIGNED: 'ok', PREPAID: 'ok', MATCHED: 'ok',
    // In flight
    IN_TRANSIT: 'info', OUT_FOR_DELIVERY: 'info', QUEUED: 'info',
    SUBMITTED: 'info', IMPORTED: 'info', PARTIALLY_BOOKED: 'info',
    PICKUP_SCHEDULED: 'info', TRIALING: 'info', PROCESSING: 'info',
    // Needs a human
    PICKUP_PENDING: 'warn', NEEDS_MANUAL_ASSIGNMENT: 'warn', NDR: 'warn',
    UNASSIGNED: 'warn', ISSUE_PENDING: 'warn', DEGRADED: 'warn',
    INCOMPLETE: 'warn', OUTCOME_UNKNOWN: 'warn', CANCEL_REQUESTED: 'warn',
    COD: 'warn', DISPUTED: 'warn', MISMATCH: 'warn', PENDING: 'warn',
    // Bad / terminal-unsuccessful
    FAILED: 'bad', VOID: 'bad', CANCELLED: 'bad', CANCELLED_IN_SHOPIFY: 'bad',
    CANCELLED_BY_COURIER: 'bad', CANCEL_REJECTED: 'bad',
    RTO_INITIATED: 'bad', RTO_IN_TRANSIT: 'bad', RTO_OUT_FOR_DELIVERY: 'bad',
    RTO_DELIVERED: 'bad', LOST_OR_DAMAGED: 'bad', DISCONNECTED: 'bad',
    SUSPENDED: 'bad', UNRESOLVED: 'bad',
  };

  function stateBadge(value) {
    if (!value) return '<span class="muted">—</span>';
    return '<span class="badge ' + (TONE[value] || '') + '">' + h(titleCase(value)) + '</span>';
  }

  /* §9.23: the persistent marker. Rendered from the record's own is_test flag,
     not from the current view, so a test row is unmistakable even if the two
     ever disagree. */
  function testMarker(isTest) {
    return isTest ? ' <span class="badge is-test">Test</span>' : '';
  }

  // ─── Modal ────────────────────────────────────────────────────────────
  var openModal = null;

  function modal(title, bodyHtml, footHtml) {
    closeModal();
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="' + h(title) + '">' +
        '<div class="modal-head"><h2>' + h(title) + '</h2><div class="spacer"></div>' +
          '<button class="x" data-close aria-label="Close">×</button></div>' +
        '<div class="modal-body">' + bodyHtml + '</div>' +
        (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '') +
      '</div>';
    document.body.appendChild(back);
    openModal = back;

    back.addEventListener('click', function (e) {
      if (e.target === back || e.target.hasAttribute('data-close')) closeModal();
    });
    document.addEventListener('keydown', escClose);
    return back;
  }

  function escClose(e) { if (e.key === 'Escape') closeModal(); }

  function closeModal() {
    if (openModal) { openModal.remove(); openModal = null; }
    document.removeEventListener('keydown', escClose);
  }

  // ─── Ship flow (§9.5.1) ───────────────────────────────────────────────
  function openShipModal(shipmentId, onDone) {
    var back = modal('Ship', '<div style="display:grid;place-items:center;padding:30px">' +
      '<span class="spin"></span></div>', '');

    api('/shipments/' + encodeURIComponent(shipmentId) + '/ship-modal').then(function (m) {
      var chosen = null;

      var candidates = (m.candidates || []);
      var candHtml = candidates.length ? candidates.map(function (c, i) {
        var bookable = c.serviceable !== false;
        var edd = c.eddFrom
          ? new Date(c.eddFrom).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) +
            (c.eddTo && c.eddTo !== c.eddFrom
              ? '–' + new Date(c.eddTo).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
              : '')
          : null;
        var meta = [];
        if (edd) meta.push('ETA ' + edd);
        if (c.costSource) meta.push(titleCase(c.costSource));
        // A TEST-mode courier account can only ever produce a test shipment;
        // saying so here is cheaper than explaining it after the fact.
        if (c.accountMode === 'TEST') meta.push('Test account');
        if (!bookable && c.failureReasons && c.failureReasons.length) {
          meta.push(c.failureReasons.map(titleCase).join(', '));
        }
        return '<button class="cand" data-i="' + i + '"' + (bookable ? '' : ' disabled') + '>' +
          '<div class="grow"><div class="name">' + h(c.serviceName || c.serviceCode) +
            (c.accountMode === 'TEST' ? ' <span class="badge is-test">Test</span>' : '') + '</div>' +
            '<div class="meta">' + h(meta.join(' · ') || '—') + '</div></div>' +
          '<div class="price">' + (c.estimate ? money(c.estimate.total) : '—') + '</div>' +
          '</button>';
      }).join('') : empty('No courier can serve this shipment',
        'Connect a courier account, or check serviceability for the destination pincode.');

      var w = m.weight || {};
      var pp = m.packageProfile;

      // INV-20: a line with no resolvable weight changes the billed weight, so
      // it is stated before booking rather than discovered on the invoice.
      var noWeight = (w.noWeightLines || []).length
        ? '<div class="banner warn" style="margin-bottom:14px"><div>' +
          '<strong>' + (w.noWeightLines.length) + ' line(s) have no weight.</strong><br>' +
          'They are excluded from the dead weight below, so the courier may bill more than this estimate.' +
          '</div></div>'
        : '';

      // §4.7: only one shipment on an order carries the Collectible.
      var codWarn = (m.cod && m.cod.splitWarning)
        ? '<div class="banner warn" style="margin-bottom:14px"><div>' +
          '<strong>This order has ' + num(m.cod.siblingCount) + ' shipments.</strong><br>' +
          (m.cod.thisShipmentWouldCarry
            ? 'Booking this one first makes it collect the full ₹' +
              h(m.cod.orderCodOutstanding || '0') + '. The others will collect nothing.'
            : 'Another shipment already carries the COD amount; this one will collect nothing.') +
          '</div></div>'
        : '';

      var body =
        noWeight + codWarn +
        '<dl class="kv" style="margin-bottom:16px">' +
          '<dt>Payment</dt><dd>' + stateBadge(m.paymentMode) + '</dd>' +
          '<dt>Collectible</dt><dd class="money">' +
            (Number(m.collectible) > 0 ? money(m.collectible) : '—') + '</dd>' +
          '<dt>Dead weight</dt><dd>' + h(w.deadWeightKg || '—') + ' kg' +
            (w.usedDefaultParcelWeight ? ' <span class="badge warn">default used</span>' : '') + '</dd>' +
          (pp ? '<dt>Package</dt><dd>' + h(pp.name || 'Default') + ' · ' +
            h(pp.lengthCm) + '×' + h(pp.widthCm) + '×' + h(pp.heightCm) + ' cm</dd>' : '') +
        '</dl>' +
        '<h2 style="font-size:13px;margin-bottom:9px">Courier</h2>' +
        '<div id="cands">' + candHtml + '</div>';

      var foot =
        '<span class="muted" id="shipmsg"></span><div class="spacer"></div>' +
        '<button class="btn" data-close>Cancel</button>' +
        '<button class="btn primary" id="dobook" disabled>Book</button>';

      back.querySelector('.modal-body').innerHTML = body;
      back.querySelector('.modal').insertAdjacentHTML('beforeend',
        '<div class="modal-foot">' + foot + '</div>');

      var bookBtn = back.querySelector('#dobook');
      var msg = back.querySelector('#shipmsg');

      Array.prototype.forEach.call(back.querySelectorAll('.cand'), function (el) {
        el.addEventListener('click', function () {
          if (el.hasAttribute('disabled')) return;
          Array.prototype.forEach.call(back.querySelectorAll('.cand'), function (o) {
            o.classList.remove('sel');
          });
          el.classList.add('sel');
          chosen = candidates[Number(el.getAttribute('data-i'))];
          bookBtn.disabled = false;
        });
      });

      back.addEventListener('click', function (e) {
        if (e.target !== bookBtn) return;
        if (!chosen) return;
        bookBtn.disabled = true;
        bookBtn.innerHTML = '<span class="spin"></span> Booking';
        msg.textContent = '';

        api('/shipments/' + encodeURIComponent(shipmentId) + '/book', {
          method: 'POST',
          body: {
            serviceId: chosen.serviceId,
            packageProfileId: pp ? pp.packageProfileId : undefined,
          },
        }).then(function (res) {
          closeModal();
          toast('Booking queued' + (res && res.merchantReference ? ' · ' + res.merchantReference : ''));
          if (onDone) onDone();
        }).catch(function (err) {
          if (err.message === 'unauthenticated') return;
          bookBtn.disabled = false;
          bookBtn.textContent = 'Book';
          /* INV-20: a guard failure comes back as a structured 422 and must be
             shown as itself — never flattened into "something went wrong". */
          var body = err.body || {};
          var reason = body.reason || body.code || body.status || err.message;
          msg.innerHTML = '<span style="color:var(--bad-fg)">' + h(titleCase(String(reason))) + '</span>';
          toast(titleCase(String(reason)), true);
        });
      });
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      back.querySelector('.modal-body').innerHTML =
        '<div class="banner bad"><div><strong>Could not open the ship modal.</strong><br>' +
        h(err.message) + '</div></div>';
    });
  }

  function cancelShipment(shipmentId, onDone) {
    var back = modal('Cancel shipment',
      '<p>This cancels the booking with the courier. It cannot be undone, and a ' +
      'cancelled shipment must be re-booked from scratch.</p>',
      '<div class="spacer"></div><button class="btn" data-close>Keep it</button>' +
      '<button class="btn primary" id="doCancel">Cancel shipment</button>');

    back.querySelector('#doCancel').addEventListener('click', function (e) {
      var b = e.target;
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span> Cancelling';
      api('/shipments/' + encodeURIComponent(shipmentId) + '/cancel', { method: 'POST', body: {} })
        .then(function () {
          closeModal(); toast('Shipment cancelled'); if (onDone) onDone();
        })
        .catch(function (err) {
          if (err.message === 'unauthenticated') return;
          closeModal();
          var body = err.body || {};
          toast(titleCase(String(body.reason || body.status || err.message)), true);
        });
    });
  }

  // ─── List helper ──────────────────────────────────────────────────────
  function listController(opts) {
    // Shared query state for the two list screens.
    var q = { search: '', state: '', limit: 25, offset: 0 };

    function toolbar(total) {
      var states = opts.states.map(function (s) {
        return '<option value="' + h(s) + '"' + (q.state === s ? ' selected' : '') + '>' +
          h(titleCase(s)) + '</option>';
      }).join('');
      return '<div class="toolbar">' +
        '<input class="input search" id="q" placeholder="' + h(opts.searchHint) +
          '" value="' + h(q.search) + '" />' +
        '<select class="input" id="st"><option value="">All states</option>' + states + '</select>' +
        '<div class="spacer" style="flex:1"></div>' +
        '<span class="muted">' + num(total) + ' ' + (total === 1 ? opts.noun : opts.nounPlural) + '</span>' +
        '</div>';
    }

    function render() {
      var view = document.getElementById('view');
      view.innerHTML = testBanner() +
        '<div class="page-head"><h1>' + h(opts.title) + '</h1></div>' + loading();

      var params = new URLSearchParams({
        view: state.view, limit: String(q.limit), offset: String(q.offset),
      });
      if (q.search) params.set('search', q.search);
      if (q.state) params.set('state', q.state);

      api(opts.endpoint + '?' + params.toString()).then(function (page) {
        var rows = page.items.length
          ? page.items.map(opts.row).join('')
          : '';
        var body = rows
          ? '<div class="table-wrap"><table class="data"><thead><tr>' +
              opts.columns.map(function (c) {
                return '<th' + (c.num ? ' class="num"' : '') + '>' + h(c.label) + '</th>';
              }).join('') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>'
          : empty(opts.emptyTitle, opts.emptySub);

        var from = page.total === 0 ? 0 : page.offset + 1;
        var to = Math.min(page.offset + page.limit, page.total);
        var pager = page.total > page.limit
          ? '<div class="pager"><span class="muted">' + from + '–' + to + ' of ' + num(page.total) + '</span>' +
            '<div style="flex:1"></div>' +
            '<button class="btn sm" id="prev"' + (page.offset === 0 ? ' disabled' : '') + '>Previous</button>' +
            '<button class="btn sm" id="next"' + (to >= page.total ? ' disabled' : '') + '>Next</button>' +
            '</div>'
          : '';

        view.innerHTML = testBanner() +
          '<div class="page-head"><h1>' + h(opts.title) + '</h1></div>' +
          '<div class="card"><div class="card-head">' + toolbar(page.total) + '</div>' +
          '<div class="card-body flush">' + body + '</div>' + pager + '</div>';

        var searchEl = document.getElementById('q');
        var debounce;
        searchEl.addEventListener('input', function () {
          clearTimeout(debounce);
          debounce = setTimeout(function () {
            q.search = searchEl.value.trim(); q.offset = 0; render();
          }, 280);
        });
        document.getElementById('st').addEventListener('change', function (e) {
          q.state = e.target.value; q.offset = 0; render();
        });
        /* Row actions are delegated, and bound ONCE per painted shell. render()
           re-runs on every filter change and keystroke; binding here without
           the guard would stack a listener each time and fire the modal N
           times on one click. The flag lives on the element, which paint()
           recreates, so it resets exactly when it should. */
        if (!view.dataset.rowActionsBound) {
          view.dataset.rowActionsBound = '1';
          view.addEventListener('click', function (e) {
            var el = e.target instanceof Element ? e.target : null;
            if (!el) return;
            var ship = el.closest('[data-ship]');
            if (ship) { openShipModal(ship.getAttribute('data-ship'), render); return; }
            var cancel = el.closest('[data-cancel]');
            if (cancel) { cancelShipment(cancel.getAttribute('data-cancel'), render); }
          });
        }

        var prev = document.getElementById('prev');
        var next = document.getElementById('next');
        if (prev) prev.addEventListener('click', function () {
          q.offset = Math.max(0, q.offset - q.limit); render();
        });
        if (next) next.addEventListener('click', function () {
          q.offset = q.offset + q.limit; render();
        });
      }).catch(function (err) {
        if (err.message === 'unauthenticated') return;
        view.innerHTML = testBanner() +
          '<div class="page-head"><h1>' + h(opts.title) + '</h1></div>' + errorCard(err);
      });
    }

    return render;
  }

  /**
   * The modules were built at different times and envelope their rows
   * differently — a bare array here, {items} there, {rows,total} elsewhere.
   * Normalising once beats teaching every screen all the shapes.
   */
  function unwrap(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    var keys = ['items', 'rows', 'jobs', 'batches', 'cases', 'invoices',
                'plans', 'schedules', 'members', 'data', 'results'];
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    }
    return [];
  }

  function totalOf(payload, rows) {
    if (payload && typeof payload.total === 'number') return payload.total;
    if (payload && typeof payload.count === 'number') return payload.count;
    return rows.length;
  }

  /**
   * A read-only table screen. Most remaining modules are exactly this: fetch a
   * collection, render columns, say something useful when it is empty.
   *
   * `opts.viewAware` sends the §9.23 view param; only pass it for endpoints
   * that actually accept one, so we never send a filter that is silently
   * ignored and leaves the operator thinking test data is filtered when it is
   * not.
   */
  function simpleScreen(opts) {
    return function () {
      var view = document.getElementById('view');
      var head = '<div class="page-head"><h1>' + h(opts.title) + '</h1>' +
        (opts.subtitle ? '<span class="muted">' + h(opts.subtitle) + '</span>' : '') +
        '</div>';
      view.innerHTML = (opts.viewAware ? testBanner() : '') + head + loading();

      var url = opts.endpoint + (opts.viewAware
        ? (opts.endpoint.indexOf('?') === -1 ? '?' : '&') + 'view=' + state.view
        : '');

      Promise.resolve(opts.fetch ? opts.fetch() : api(url)).then(function (payload) {
        var rows = unwrap(payload);
        var table = rows.length
          ? '<div class="table-wrap"><table class="data"><thead><tr>' +
            opts.columns.map(function (c) {
              return '<th' + (c.num ? ' class="num"' : '') + '>' + h(c.label) + '</th>';
            }).join('') + '</tr></thead><tbody>' +
            rows.map(function (r) {
              return '<tr>' + opts.columns.map(function (c) {
                return '<td' + (c.num ? ' class="num"' : '') +
                  (c.mono ? ' class="mono"' : '') + '>' + c.cell(r) + '</td>';
              }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>'
          : empty(opts.emptyTitle, opts.emptySub);

        view.innerHTML = (opts.viewAware ? testBanner() : '') + head +
          (opts.above ? opts.above(payload) : '') +
          '<div class="card"><div class="card-head"><h2>' + h(opts.tableTitle || opts.title) + '</h2>' +
            '<div class="spacer"></div><span class="muted" style="font-size:12.5px">' +
            num(totalOf(payload, rows)) + '</span></div>' +
          '<div class="card-body flush">' + table + '</div></div>';
      }).catch(function (err) {
        if (err.message === 'unauthenticated') return;
        /* A 403 here is a role boundary, not a fault — §10.2 grants these
           screens to different roles, so say which permission is missing
           rather than showing a red error. */
        view.innerHTML = (opts.viewAware ? testBanner() : '') + head +
          (err.status === 403
            ? '<div class="card"><div class="card-body">' +
              empty('Not available for your role',
                'This screen needs a permission your role does not hold (§10.2).') +
              '</div></div>'
            : errorCard(err));
      });
    };
  }

  // ─── Screens ──────────────────────────────────────────────────────────
  var CARD_META = {
    new_to_book: { label: 'Ready to book', to: '#/shipments' },
    ndr_open: { label: 'Open NDR' },
    pickup_pending: { label: 'Pickup pending' },
    delayed: { label: 'Delayed' },
    manual_assignment: { label: 'Manual assignment' },
    courier_disconnected: { label: 'Couriers disconnected', to: '#/couriers' },
    recon_disputes_open: { label: 'Recon disputes' },
    cod_unassigned: { label: 'COD unassigned' },
    invoice_issue_pending: { label: 'Invoices pending' },
  };

  function screenDashboard() {
    var view = document.getElementById('view');
    view.innerHTML = testBanner() + '<div class="page-head"><h1>Dashboard</h1></div>' + loading();

    api('/dashboard?view=' + state.view).then(function (d) {
      var tiles = Object.keys(CARD_META).map(function (key) {
        var meta = CARD_META[key];
        var v = (d.cards && d.cards[key]) || 0;
        var inner =
          '<div class="tile-label">' + h(meta.label) + '</div>' +
          '<div class="tile-value' + (v > 0 ? ' attn' : ' zero') + '">' + num(v) + '</div>';
        var cls = 'tile' + (v > 0 ? '' : ' quiet');
        return meta.to && v > 0
          ? '<a class="' + cls + '" href="' + meta.to + '">' + inner + '</a>'
          : '<div class="' + cls + '">' + inner + '</div>';
      }).join('');

      var t = (d.todayVsYesterday && d.todayVsYesterday.today) || { booked: 0, delivered: 0 };
      var y = (d.todayVsYesterday && d.todayVsYesterday.yesterday) || { booked: 0, delivered: 0 };

      function delta(a, b) {
        var diff = a - b;
        if (!b && !a) return '<span class="muted">no change</span>';
        var sign = diff > 0 ? '▲' : diff < 0 ? '▼' : '■';
        var tone = diff > 0 ? 'ok' : diff < 0 ? 'bad' : '';
        return '<span class="badge ' + tone + '">' + sign + ' ' + Math.abs(diff) + ' vs yesterday</span>';
      }

      /* §4.10 / F-16: none of these three rates is "over booked", and showing
         them beside a Booked column invites exactly that misreading — a
         delivery rate of 100% next to "12 booked, 2 delivered" looks broken
         when it is correct. So the denominator is named in the header and the
         exact formula is in the tooltip, and Resolved is shown so the
         arithmetic is checkable on screen. */
      function pct(v) {
        return v === null || v === undefined ? '<span class="muted">—</span>'
                                            : (v * 100).toFixed(1) + '%';
      }
      var perf = (d.servicePerformance || []).slice(0, 8).map(function (r) {
        var resolved = (r.delivered || 0) + (r.rtoDelivered || 0);
        return '<tr>' +
          '<td>' + h(r.serviceName || r.courierCode || 'Unassigned') + '</td>' +
          '<td class="num">' + num(r.booked) + '</td>' +
          '<td class="num">' + num(r.delivered) + '</td>' +
          '<td class="num">' + (resolved ? num(resolved) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num">' + pct(r.deliveryRate) + '</td>' +
          '<td class="num">' + pct(r.rtoRate) + '</td>' +
          '<td class="num">' + pct(r.ndrRate) + '</td>' +
          '<td class="num">' + (r.avgTatHours === null || r.avgTatHours === undefined
            ? '<span class="muted">—</span>' : r.avgTatHours.toFixed(1) + ' h') + '</td>' +
          '</tr>';
      }).join('');

      /* §5.2: every figure carries an as-of, and staleness is stated rather
         than hidden — silently showing old numbers as current is worse than
         showing them as old. */
      var asOf = d.asOf
        ? 'Figures as of ' + dateTime(d.asOf) + ' · ' + relative(d.asOf)
        : 'No rollup has been computed yet';
      var stale = d.stale
        ? '<div class="banner warn" style="margin-bottom:16px"><div>' +
          '<strong>Figures may be out of date.</strong><br>' + h(asOf) +
          '. Dashboard figures come from hourly rollups (§5.2).</div></div>'
        : '';

      view.innerHTML = testBanner() + stale +
        '<div class="page-head"><h1>Dashboard</h1><div class="spacer"></div>' +
          '<span class="muted" style="font-size:12.5px">' + h(asOf) + '</span></div>' +
        '<div class="stack">' +
          '<div class="tiles">' + tiles + '</div>' +
          '<div class="card"><div class="card-head"><h2>Today</h2></div>' +
            '<div class="card-body"><div class="row" style="gap:34px">' +
              '<div><div class="tile-label">Booked</div>' +
                '<div class="tile-value">' + num(t.booked) + '</div>' +
                '<div class="tile-sub">' + delta(t.booked, y.booked) + '</div></div>' +
              '<div><div class="tile-label">Delivered</div>' +
                '<div class="tile-value">' + num(t.delivered) + '</div>' +
                '<div class="tile-sub">' + delta(t.delivered, y.delivered) + '</div></div>' +
            '</div></div></div>' +
          '<div class="card"><div class="card-head"><h2>Service performance</h2>' +
            '<div class="spacer"></div><span class="muted" style="font-size:12.5px">Last 30 days</span></div>' +
            '<div class="card-body flush">' +
            (perf
              ? '<div class="table-wrap"><table class="data"><thead><tr>' +
                '<th>Service</th>' +
                '<th class="num">Booked</th>' +
                '<th class="num">Delivered</th>' +
                '<th class="num" title="Delivered + RTO delivered — shipments that reached a terminal outcome">Resolved</th>' +
                '<th class="num" title="F-16.a — Delivered ÷ (Delivered + RTO delivered). Of resolved shipments, the share that reached the customer. Not a share of booked.">Delivered ÷ resolved</th>' +
                '<th class="num" title="F-16.c — RTO delivered ÷ all terminal shipments">RTO ÷ terminal</th>' +
                '<th class="num" title="F-16.b — Shipments with at least one NDR ÷ picked-up shipments">NDR ÷ picked up</th>' +
                '<th class="num" title="F-16.d — mean hours from picked up to delivered">Avg TAT</th>' +
                '</tr></thead><tbody>' + perf + '</tbody></table></div>'
              : empty('No performance data yet', 'Figures appear once shipments have been booked and rolled up.')) +
            '</div></div>' +
        '</div>';
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      view.innerHTML = testBanner() + '<div class="page-head"><h1>Dashboard</h1></div>' + errorCard(err);
    });
  }

  var screenOrders = listController({
    title: 'Orders',
    noun: 'order', nounPlural: 'orders',
    endpoint: '/orders',
    searchHint: 'Search order number…',
    // The real order_state enum. Offering a label the enum does not have
    // silently returns nothing, which reads as "no orders" rather than
    // "that state does not exist".
    states: ['IMPORTED', 'INCOMPLETE', 'READY', 'PARTIALLY_BOOKED', 'FULLY_BOOKED',
             'CLOSED', 'CANCELLED_IN_SHOPIFY'],
    emptyTitle: 'No orders here',
    emptySub: 'Orders sync from Shopify automatically once webhooks are delivering.',
    columns: [
      { label: 'Order' }, { label: 'State' }, { label: 'Payment' },
      { label: 'Destination' }, { label: 'Amount', num: true },
      { label: 'COD due', num: true }, { label: 'Shipments', num: true }, { label: 'Created' },
    ],
    row: function (o) {
      var dest = [o.city, o.state].filter(Boolean).join(', ');
      return '<tr>' +
        '<td><a class="row-link" href="#/orders/' + h(o.orderId) + '">' +
          h(o.orderNumber || o.orderId.slice(0, 8)) + '</a>' + testMarker(o.isTest) + '</td>' +
        '<td>' + stateBadge(o.orderState) + '</td>' +
        '<td>' + stateBadge(o.paymentMode) + '</td>' +
        '<td>' + (dest ? h(dest) + (o.pincode ? ' <span class="muted mono">' + h(o.pincode) + '</span>' : '')
                       : '<span class="muted">—</span>') + '</td>' +
        '<td class="num money">' + money(o.orderAmount) + '</td>' +
        '<td class="num money">' + (Number(o.codOutstanding) > 0 ? money(o.codOutstanding) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + num(o.shipmentCount) + '</td>' +
        '<td class="muted">' + h(dateTime(o.createdAt)) + '</td>' +
        '</tr>';
    },
  });

  var screenShipments = listController({
    title: 'Shipments',
    noun: 'shipment', nounPlural: 'shipments',
    endpoint: '/shipments',
    searchHint: 'Search AWB or order number…',
    // The real booking_state enum (§3.2).
    states: ['DRAFT', 'NEEDS_MANUAL_ASSIGNMENT', 'QUEUED', 'SUBMITTED', 'CONFIRMED',
             'FAILED', 'OUTCOME_UNKNOWN', 'VOID'],
    emptyTitle: 'No shipments here',
    emptySub: 'A shipment appears once an order is ready to book.',
    columns: [
      { label: 'AWB' }, { label: 'Order' }, { label: 'Courier' }, { label: 'Booking' },
      { label: 'Movement' }, { label: 'COD', num: true }, { label: 'Booked' }, { label: '' },
    ],
    row: function (s) {
      /* §3.2/§3.3: only a DRAFT can be booked, and only a booked shipment that
         has not yet entered courier custody can be cancelled. Offering an
         action the state machine would refuse is worse than offering none. */
      var action = '';
      if (s.bookingState === 'DRAFT' || s.bookingState === 'FAILED') {
        action = '<button class="btn sm primary" data-ship="' + h(s.shipmentId) + '">Ship</button>';
      } else if (s.bookingState === 'CONFIRMED' && s.custodyState === 'PICKUP_PENDING') {
        action = '<button class="btn sm" data-cancel="' + h(s.shipmentId) + '">Cancel</button>';
      }
      return '<tr>' +
        '<td class="mono">' + (s.awb ? h(s.awb) : '<span class="muted">not booked</span>') +
          testMarker(s.isTest) + '</td>' +
        '<td><a class="row-link" href="#/orders/' + h(s.orderId) + '">' +
          h(s.orderNumber || s.orderId.slice(0, 8)) + '</a></td>' +
        '<td>' + (s.courierCode ? h(titleCase(s.courierCode)) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + stateBadge(s.bookingState) + '</td>' +
        '<td>' + stateBadge(s.movementState) + '</td>' +
        '<td class="num money">' + (Number(s.collectible) > 0 ? money(s.collectible) : '<span class="muted">—</span>') + '</td>' +
        '<td class="muted">' + h(s.bookedAt ? dateTime(s.bookedAt) : '—') + '</td>' +
        '<td style="text-align:right">' + action + '</td>' +
        '</tr>';
    },
  });

  function screenOrderDetail(orderId) {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Order</h1></div>' + loading();

    api('/orders/' + encodeURIComponent(orderId)).then(function (o) {
      var lines = (o.lines || []).map(function (l) {
        return '<tr><td>' + h(l.title || '—') + '</td>' +
          '<td class="mono muted">' + h(l.sku || '—') + '</td>' +
          '<td class="num">' + num(l.quantity) + '</td>' +
          '<td class="num money">' + money(l.unitPrice) + '</td></tr>';
      }).join('');

      var ships = (o.shipments || []).map(function (s) {
        return '<tr>' +
          '<td class="mono">' + (s.awb ? h(s.awb) : '<span class="muted">not booked</span>') +
            testMarker(s.isTest) + '</td>' +
          '<td>' + (s.courierCode ? h(titleCase(s.courierCode)) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + stateBadge(s.bookingState) + '</td>' +
          '<td>' + stateBadge(s.movementState) + '</td>' +
          '<td class="num money">' + (Number(s.collectible) > 0 ? money(s.collectible) : '—') + '</td>' +
          '<td class="muted">' + h(s.bookedAt ? dateTime(s.bookedAt) : '—') + '</td>' +
          '</tr>';
      }).join('');

      var dest = [o.city, o.state, o.pincode].filter(Boolean).join(', ');

      view.innerHTML =
        '<div class="page-head">' +
          '<a class="btn sm" href="#/orders">← Orders</a>' +
          '<h1>' + h(o.orderNumber || 'Order') + '</h1>' + testMarker(o.isTest) +
          stateBadge(o.orderState) +
        '</div>' +
        '<div class="stack">' +
          '<div class="card"><div class="card-body">' +
            '<dl class="kv">' +
              '<dt>Payment</dt><dd>' + stateBadge(o.paymentMode) + '</dd>' +
              '<dt>COD assignment</dt><dd>' + stateBadge(o.codAssignmentState) + '</dd>' +
              '<dt>Order amount</dt><dd class="money">' + money(o.orderAmount) + '</dd>' +
              '<dt>COD outstanding</dt><dd class="money">' + money(o.codOutstanding) + '</dd>' +
              '<dt>Destination</dt><dd>' + (dest ? h(dest) : '<span class="muted">—</span>') + '</dd>' +
              '<dt>Source</dt><dd>' + h(titleCase(o.source)) + '</dd>' +
              (o.riskFlag ? '<dt>Risk</dt><dd><span class="badge warn">' + h(o.riskFlag) + '</span></dd>' : '') +
              '<dt>Created</dt><dd>' + h(dateTime(o.createdAtShopify || o.createdAt)) + '</dd>' +
            '</dl>' +
            /* §9.16 / RV-13 minimisation: the console shows only city, state
               and pincode. Name, phone, email and address lines are protected
               customer data and are not rendered on a list or detail screen. */
            '<p class="muted" style="margin:14px 0 0;font-size:12.5px">' +
              'Recipient contact details are protected customer data and are not shown here.' +
            '</p>' +
          '</div></div>' +
          '<div class="card"><div class="card-head"><h2>Items</h2></div>' +
            '<div class="card-body flush">' +
            (lines ? '<div class="table-wrap"><table class="data"><thead><tr>' +
              '<th>Item</th><th>SKU</th><th class="num">Qty</th><th class="num">Unit price</th>' +
              '</tr></thead><tbody>' + lines + '</tbody></table></div>'
                   : empty('No line items')) +
            '</div></div>' +
          '<div class="card"><div class="card-head"><h2>Shipments</h2></div>' +
            '<div class="card-body flush">' +
            (ships ? '<div class="table-wrap"><table class="data"><thead><tr>' +
              '<th>AWB</th><th>Courier</th><th>Booking</th><th>Movement</th>' +
              '<th class="num">COD</th><th>Booked</th>' +
              '</tr></thead><tbody>' + ships + '</tbody></table></div>'
                   : empty('No shipments yet', 'A shipment is created when the order becomes ready to book.')) +
            '</div></div>' +
        '</div>';
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><a class="btn sm" href="#/orders">← Orders</a>' +
        '<h1>Order</h1></div>' +
        (err.status === 404
          ? '<div class="card"><div class="card-body">' + empty('Order not found',
              'It may belong to another store, or have been removed.') + '</div></div>'
          : errorCard(err));
    });
  }

  /**
   * §9.3.3 courier connect. BYOC: the merchant brings their own courier
   * contract, so this screen is where an account is connected, tested and
   * switched between test and live.
   *
   * The connect form is built from the courier's own credential-field schema
   * rather than hardcoded per courier — adding a courier to the master data is
   * then enough to make it connectable here.
   */
  function screenCouriers() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Couriers</h1></div>' + loading();

    Promise.all([
      api('/couriers').catch(function () { return []; }),
      // Owner-only (§10.2). A non-Owner still sees the catalogue, just no
      // accounts and no connect action.
      api('/courier-accounts').then(function (r) { return { ok: r }; })
        .catch(function (e) { return { err: e }; }),
    ]).then(function (res) {
      var list = unwrap(res[0]).length ? unwrap(res[0]) : (res[0] || []);
      var acctRes = res[1] || {};
      var isOwner = !acctRes.err;
      var accounts = unwrap(acctRes.ok).length ? unwrap(acctRes.ok) : (acctRes.ok || []);
      if (!Array.isArray(accounts)) accounts = [];

      var byCourier = {};
      accounts.forEach(function (a) {
        var key = a.courierId || a.courier_id;
        (byCourier[key] = byCourier[key] || []).push(a);
      });

      var rows = list.map(function (c) {
        var accts = byCourier[c.courierId] || [];
        var a = accts[0];
        var health = a && (a.healthState || a.health_state);
        var mode = a && (a.mode || a.accountMode);
        var enabled = a && (a.enabled !== undefined ? a.enabled : a.is_enabled);

        var status = !a ? '<span class="badge">Not connected</span>'
          : stateBadge(health || 'UNVERIFIED') +
            (mode ? ' <span class="badge' + (mode === 'TEST' ? ' is-test' : '') + '">' +
              h(mode) + '</span>' : '') +
            (a && enabled === false ? ' <span class="badge warn">Disabled</span>' : '');

        var action = !isOwner ? ''
          : !a
            ? '<button class="btn sm primary" data-connect="' + h(c.courierId) + '">Connect</button>'
            : '<button class="btn sm" data-test="' + h(a.courierAccountId || a.courier_account_id) + '">Test</button>' +
              ' <button class="btn sm" data-manage="' + h(c.courierId) + '">Manage</button>';

        return '<tr>' +
          '<td><strong>' + h(c.name || titleCase(c.code)) + '</strong>' +
            (c.kind ? '<div class="muted" style="font-size:12px">' + h(titleCase(c.kind)) + '</div>' : '') +
          '</td>' +
          '<td class="mono muted">' + h(c.code) + '</td>' +
          '<td>' + status + '</td>' +
          '<td style="text-align:right">' + action + '</td>' +
          '</tr>';
      }).join('');

      view.innerHTML =
        '<div class="page-head"><h1>Couriers</h1>' +
          '<span class="muted">Connect your own courier contracts</span></div>' +
        (isOwner ? '' :
          '<div class="banner warn" style="margin-bottom:16px"><div>' +
          'Only the store Owner can connect or change courier accounts (§10.2).' +
          '</div></div>') +
        '<div class="card">' +
          '<div class="card-head"><h2>Launch couriers</h2><div class="spacer"></div>' +
            '<span class="muted" style="font-size:12.5px">' + num(list.length) + '</span></div>' +
          '<div class="card-body flush">' +
          (rows ? '<div class="table-wrap"><table class="data"><thead><tr>' +
            '<th>Courier</th><th>Code</th><th>Status</th><th></th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>'
                : empty('No couriers available', 'The courier master data has not been seeded.')) +
          '</div></div>';

      var host = document.getElementById('view');
      if (!host.dataset.courierBound) {
        host.dataset.courierBound = '1';
        host.addEventListener('click', function (e) {
          var el = e.target instanceof Element ? e.target : null;
          if (!el) return;
          var conn = el.closest('[data-connect]');
          if (conn) {
            var courier = list.filter(function (x) {
              return x.courierId === conn.getAttribute('data-connect');
            })[0];
            if (courier) openConnectModal(courier, screenCouriers);
            return;
          }
          var t = el.closest('[data-test]');
          if (t) { runTestConnection(t.getAttribute('data-test'), screenCouriers); return; }
          var m = el.closest('[data-manage]');
          if (m) {
            var cc = list.filter(function (x) { return x.courierId === m.getAttribute('data-manage'); })[0];
            var acct = (byCourier[m.getAttribute('data-manage')] || [])[0];
            if (cc && acct) openManageModal(cc, acct, screenCouriers);
          }
        });
      }
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Couriers</h1></div>' + errorCard(err);
    });
  }

  /**
   * Where each courier's credentials come from.
   *
   * A merchant connecting a courier is holding a contract, not an API doc —
   * "API token" alone does not tell them which of the several values their
   * account manager sent is the right one. These describe WHAT the value is
   * and WHO issues it, which stays true even when a courier reshuffles its
   * portal menus. Exact menu names are deliberately not asserted.
   *
   * Server-side guides (courier_guide, editable by staff) take precedence when
   * present; this is the fallback so the form is never unexplained.
   */
  var CREDENTIAL_GUIDE = {
    DELHIVERY: {
      where: 'Issued with your Delhivery API contract. Your Delhivery account ' +
        'manager provides it, and it is also shown in the Delhivery One portal ' +
        'under the API/integration settings.',
      fields: {
        api_token: 'The long API token (sometimes called the API key). Paste it whole — no "Token" prefix.',
        pickup_code: 'The warehouse / client name exactly as registered with Delhivery. ' +
          'It must match character-for-character or bookings are rejected.',
      },
    },
    BLUEDART: {
      where: 'From your Blue Dart API gateway registration. Blue Dart issues these ' +
        'when your account is enabled for API access.',
      fields: {
        client_id: 'The consumer key from the Blue Dart API gateway (ClientID / ConsumerKey).',
        client_secret: 'The consumer secret paired with that key. Blue Dart shows it once at registration.',
        pickup_code: 'Your registered Blue Dart customer code for the pickup location — ' +
          'the code on your Blue Dart contract, not our internal id.',
      },
    },
    DTDC: {
      where: 'From your DTDC API onboarding. DTDC issues an access token per customer account.',
      fields: {
        api_key: 'The access token DTDC issues for the consignment API (sent as X-Access-Token).',
        pickup_code: 'Your DTDC-registered customer code.',
      },
    },
    XPRESSBEES: {
      where: 'The same credentials you use to sign in to the Xpressbees dashboard. ' +
        'If your account has a separate API user, use that one.',
      fields: {
        email: 'Your Xpressbees login email.',
        password: 'Your Xpressbees password. It is encrypted before storage and never shown again.',
        pickup_code: 'The warehouse name exactly as registered in Xpressbees.',
      },
    },
    SHADOWFAX: {
      where: 'From your Shadowfax merchant onboarding — your account manager issues the API key.',
      fields: {
        api_key: 'The Shadowfax API key for your merchant account.',
        pickup_code: 'Your Shadowfax pickup location code.',
      },
    },
    SHIPROCKET: {
      where: 'Shiprocket is an aggregator: these are your Shiprocket account credentials, ' +
        'and Shiprocket holds the courier contracts behind it.',
      fields: {
        email: 'Your Shiprocket login email.',
        password: 'Your Shiprocket password.',
        shiprocket_courier_map: 'Optional routing map for Shiprocket’s nested couriers. ' +
          'Leave empty unless you have been given one.',
        pickup_code: 'The pickup location nickname registered in Shiprocket.',
      },
    },
    AMAZON_SHIPPING: {
      where: 'From Amazon Seller Central → Apps & Services → Develop Apps (Login with Amazon). ' +
        'You need a developer profile before these exist.',
      fields: {
        client_id: 'The LWA application client ID.',
        client_secret: 'The LWA application client secret.',
        refresh_token: 'The refresh token from authorising the app against your selling account.',
        pickup_code: 'The ship-from address ID registered with Amazon.',
      },
    },
  };

  /** Renders one credential field from the courier's own schema. */
  function credentialField(f, courierCode) {
    var id = 'cred_' + f.key;
    var guide = CREDENTIAL_GUIDE[courierCode];
    var hint = guide && guide.fields ? guide.fields[f.key] : null;
    return '<div>' +
      '<label for="' + h(id) + '">' + h(f.label || f.key) +
        (f.isRequired ? '' : ' <span class="muted">(optional)</span>') + '</label>' +
      '<input class="input" id="' + h(id) + '" data-key="' + h(f.key) + '"' +
        // Secrets are write-only (§5.7 control 3) — never prefilled, never
        // echoed back, and masked while typing.
        ' type="' + (f.isSecret ? 'password' : 'text') + '"' +
        ' autocomplete="off" spellcheck="false" style="width:100%"' +
        (f.isRequired ? ' required' : '') + ' />' +
      (hint ? '<div class="muted" style="font-size:12px;margin-top:3px">' + h(hint) + '</div>' : '') +
      '</div>';
  }

  /** The "where do I get these?" panel above the fields. */
  function credentialGuideBlock(courier) {
    var g = CREDENTIAL_GUIDE[courier.code] || {};
    // A staff-published guide (courier_guide) outranks the built-in copy.
    var srv = courier.guide || {};
    var links = [];
    if (srv.docUrl) links.push('<a href="' + h(srv.docUrl) + '" target="_blank" rel="noopener">Setup guide</a>');
    if (srv.videoUrl) links.push('<a href="' + h(srv.videoUrl) + '" target="_blank" rel="noopener">Video walkthrough</a>');

    if (!g.where && !links.length) return '';
    return '<div class="banner" style="background:var(--surface-sunk);border-color:var(--border);' +
      'margin-bottom:14px"><div>' +
      '<strong>Where to find these</strong><br>' +
      (g.where ? h(g.where) : '') +
      (links.length ? '<div style="margin-top:6px">' + links.join(' · ') + '</div>' : '') +
      '</div></div>';
  }

  function collectCredentials(scope) {
    var creds = {};
    Array.prototype.forEach.call(scope.querySelectorAll('[data-key]'), function (i) {
      var v = i.value.trim();
      if (v) creds[i.getAttribute('data-key')] = v;
    });
    return creds;
  }

  function openConnectModal(courier, onDone) {
    var fields = (courier.credentialFields || []).slice().sort(function (a, b) {
      return (a.displayOrder || 0) - (b.displayOrder || 0);
    });

    var body =
      '<p class="muted" style="margin-top:0">' +
        'Enter the API credentials from your ' + h(courier.name) + ' contract. ' +
        'They are encrypted before storage and never shown again (§5.7).' +
      '</p>' +
      credentialGuideBlock(courier) +
      /* §9.3.3 defaults to TEST. A live courier account books real parcels and
         spends real money — opting into that should be deliberate. */
      '<div style="display:grid;gap:8px;margin:14px 0">' +
        '<label>Mode</label>' +
        '<div class="seg" id="modeseg">' +
          '<button type="button" data-mode="TEST" class="on">Test</button>' +
          '<button type="button" data-mode="LIVE">Live</button>' +
        '</div>' +
        '<span class="muted" style="font-size:12.5px" id="modehint">' +
          'Test mode books against the courier sandbox. Nothing real ships.</span>' +
      '</div>' +
      (fields.length
        ? '<form id="credform" style="display:grid;gap:10px">' +
          fields.map(function (f) { return credentialField(f, courier.code); }).join('') + '</form>'
        : '<div class="banner warn"><div>This courier has no credential schema configured, ' +
          'so it cannot be connected yet.</div></div>');

    var back = modal('Connect ' + courier.name, body,
      '<span id="connmsg" class="muted"></span><div class="spacer"></div>' +
      '<button class="btn" data-close>Cancel</button>' +
      '<button class="btn primary" id="doconnect"' + (fields.length ? '' : ' disabled') + '>Connect</button>');

    var mode = 'TEST';
    Array.prototype.forEach.call(back.querySelectorAll('#modeseg button'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(back.querySelectorAll('#modeseg button'), function (o) {
          o.classList.remove('on');
        });
        b.classList.add('on');
        mode = b.getAttribute('data-mode');
        back.querySelector('#modehint').textContent = mode === 'LIVE'
          ? 'Live mode books real shipments with real money.'
          : 'Test mode books against the courier sandbox. Nothing real ships.';
      });
    });

    var btn = back.querySelector('#doconnect');
    var msg = back.querySelector('#connmsg');
    if (btn) btn.addEventListener('click', function () {
      var form = back.querySelector('#credform');
      if (form && !form.reportValidity()) return;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Connecting';
      msg.textContent = '';

      api('/courier-accounts', {
        method: 'POST',
        body: { courierId: courier.courierId, mode: mode, credentials: collectCredentials(back) },
      }).then(function (acct) {
        var id = acct && (acct.courierAccountId || acct.courier_account_id);
        toast(courier.name + ' connected');
        // §3.21: a new account is UNVERIFIED until a real call succeeds, so
        // test immediately rather than leaving the merchant to wonder.
        if (id) return runTestConnection(id, null, true);
      }).then(function () {
        closeModal();
        if (onDone) onDone();
      }).catch(function (err) {
        if (err.message === 'unauthenticated') return;
        btn.disabled = false;
        btn.textContent = 'Connect';
        var b = err.body || {};
        // A1-12 returns per-field issues; showing them beats a generic failure.
        var detail = Array.isArray(b.issues) && b.issues.length
          ? b.issues.map(function (i) {
              return (i.field || i.key || '') + ': ' + (i.message || i.reason || 'invalid');
            }).join(' · ')
          : (b.message || b.reason || err.message);
        msg.innerHTML = '<span style="color:var(--bad-fg)">' + h(String(detail)) + '</span>';
      });
    });
  }

  function runTestConnection(accountId, onDone, quiet) {
    return api('/courier-accounts/' + encodeURIComponent(accountId) + '/test-connection',
      { method: 'POST', body: {} })
      .then(function (r) {
        var state = r && (r.healthState || r.health_state || r.state);
        var ok = state === 'HEALTHY' || r === true || (r && r.ok);
        if (!quiet) toast(ok ? 'Connection healthy' : 'Test finished: ' + titleCase(String(state || 'unknown')), !ok);
        if (onDone) onDone();
      })
      .catch(function (err) {
        if (err.message === 'unauthenticated') return;
        var b = err.body || {};
        toast('Test failed: ' + String(b.message || b.reason || err.message), true);
        if (onDone) onDone();
      });
  }

  /**
   * The per-store account surface: credentials, mode, the ADD-18 webhook this
   * store gives its courier, and which of the courier's services (shipping
   * methods) are enabled. Every one of these is scoped to this shop's own
   * account — a courier contract belongs to the merchant, not the platform.
   */
  function openManageModal(courier, acct, onDone) {
    var accountId = acct.courierAccountId || acct.courier_account_id;
    var mode = acct.mode || acct.accountMode || 'TEST';
    var enabled = acct.enabled !== undefined ? acct.enabled : acct.is_enabled !== false;
    var fields = (courier.credentialFields || []).slice().sort(function (a, b) {
      return (a.displayOrder || 0) - (b.displayOrder || 0);
    });

    var back = modal('Manage ' + courier.name,
      '<div style="display:grid;place-items:center;padding:26px"><span class="spin"></span></div>', '');

    function fail(err) {
      if (err.message === 'unauthenticated') return;
      var b = err.body || {};
      toast(String(b.message || b.reason || err.message), true);
    }
    function refresh() { closeModal(); if (onDone) onDone(); }

    Promise.all([
      api('/courier-accounts/' + encodeURIComponent(accountId) + '/webhook')
        .catch(function (e) { return { __err: e }; }),
      api('/courier-accounts/' + encodeURIComponent(accountId) + '/services')
        .catch(function () { return []; }),
    ]).then(function (res) {
      var wh = res[0] || {};
      var services = unwrap(res[1]).length ? unwrap(res[1]) : (res[1] || []);
      if (!Array.isArray(services)) services = [];

      var whBlock = wh.__err
        ? '<div class="banner warn"><div>Webhook details unavailable: ' + h(wh.__err.message) + '</div></div>'
        : '<p class="muted" style="font-size:12.5px;margin-top:0">' +
            'Give this URL to ' + h(courier.name) + ' as your tracking webhook. It is unique to ' +
            'this store and this account — events signed with your secret arrive here.</p>' +
          '<div class="row" style="gap:8px;margin-bottom:10px">' +
            '<input class="input mono" id="whurl" readonly style="flex:1;font-size:12px" value="' +
              h(wh.webhookUrl || '') + '" />' +
            '<button class="btn sm" id="copywh">Copy</button>' +
          '</div>' +
          '<dl class="kv" style="margin-bottom:12px">' +
            '<dt>Signing secret</dt><dd>' + (wh.secretSet
              ? '<span class="badge ok">Set</span>'
              : '<span class="badge warn">Not set</span>') + '</dd>' +
            '<dt>Events (24h)</dt><dd>' + num(wh.events24h) + '</dd>' +
            '<dt>Signature failures (24h)</dt><dd>' +
              (wh.signatureFailures24h > 0
                ? '<span class="badge bad">' + num(wh.signatureFailures24h) + '</span>'
                : num(wh.signatureFailures24h)) + '</dd>' +
            '<dt>Last event</dt><dd>' + (wh.lastEventReceivedAt
              ? h(dateTime(wh.lastEventReceivedAt)) : '<span class="muted">never</span>') + '</dd>' +
          '</dl>' +
          '<div class="row">' +
            '<button class="btn sm" id="whtest">Send test event</button>' +
            '<button class="btn sm" id="whsecret">Regenerate secret</button>' +
            '<button class="btn sm" id="whtoken">Regenerate URL</button>' +
          '</div>' +
          '<p class="note" style="margin-bottom:0">Regenerating the URL stops the old one ' +
            'immediately — update it with the courier first.</p>';

      /* §9.3.2: services are this account's shipping methods. Disabling one
         removes it from rate selection without touching the account. */
      var svcBlock = services.length
        ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Service</th><th>Cost source</th><th></th></tr></thead><tbody>' +
          services.map(function (s) {
            return '<tr><td><strong>' + h(s.serviceName || s.serviceCode) + '</strong>' +
              '<div class="mono muted" style="font-size:11.5px">' + h(s.serviceCode) + '</div></td>' +
              '<td>' + stateBadge(s.costSource) + '</td>' +
              '<td style="text-align:right">' +
                '<button class="btn sm" data-svc="' + h(s.serviceId) + '" data-on="' +
                  (s.enabled ? '1' : '0') + '">' + (s.enabled ? 'Enabled' : 'Disabled') + '</button>' +
              '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="muted">No services are configured for this courier yet.</p>';

      back.querySelector('.modal-body').innerHTML =
        '<dl class="kv">' +
          '<dt>Health</dt><dd>' + stateBadge(acct.healthState || acct.health_state || 'UNVERIFIED') + '</dd>' +
          '<dt>Mode</dt><dd>' + stateBadge(mode) + '</dd>' +
          '<dt>Account</dt><dd>' + (enabled ? 'Enabled' : '<span class="badge warn">Disabled</span>') + '</dd>' +
        '</dl>' +
        '<div class="row" style="margin:14px 0 20px">' +
          '<button class="btn sm" id="switchmode">Switch to ' + (mode === 'TEST' ? 'Live' : 'Test') + '</button>' +
          '<button class="btn sm" id="toggleenabled">' + (enabled ? 'Disable account' : 'Enable account') + '</button>' +
          '<button class="btn sm" id="dotest">Test connection</button>' +
        '</div>' +
        '<h2 style="font-size:13px;margin:0 0 8px">Tracking webhook</h2>' + whBlock +
        '<h2 style="font-size:13px;margin:22px 0 8px">Shipping services</h2>' + svcBlock +
        '<h2 style="font-size:13px;margin:22px 0 8px">Replace credentials</h2>' +
        '<p class="muted" style="font-size:12.5px;margin-top:0">' +
          'Stored credentials cannot be displayed (§5.7). Entering new values replaces them.</p>' +
        (fields.length
          ? '<form id="credform" style="display:grid;gap:10px">' + fields.map(function (f) { return credentialField(f, courier.code); }).join('') + '</form>'
          : '');

      back.querySelector('.modal').insertAdjacentHTML('beforeend',
        '<div class="modal-foot"><div class="spacer"></div>' +
        '<button class="btn" data-close>Close</button>' +
        (fields.length ? '<button class="btn primary" id="doreplace">Replace credentials</button>' : '') +
        '</div>');

      function on(id, fn) {
        var el = back.querySelector('#' + id);
        if (el) el.addEventListener('click', fn);
      }

      on('switchmode', function () {
        api('/courier-accounts/' + encodeURIComponent(accountId) + '/mode',
          { method: 'POST', body: { mode: mode === 'TEST' ? 'LIVE' : 'TEST' } })
          .then(function () { toast('Switched to ' + (mode === 'TEST' ? 'live' : 'test')); refresh(); })
          .catch(fail);
      });
      on('toggleenabled', function () {
        api('/courier-accounts/' + encodeURIComponent(accountId) + '/enabled',
          { method: 'POST', body: { enabled: !enabled } })
          .then(function () { toast(enabled ? 'Account disabled' : 'Account enabled'); refresh(); })
          .catch(fail);
      });
      on('dotest', function () { runTestConnection(accountId, refresh); });

      on('copywh', function () {
        var i = back.querySelector('#whurl');
        i.select();
        if (navigator.clipboard) navigator.clipboard.writeText(i.value);
        else document.execCommand('copy');
        toast('Webhook URL copied');
      });
      on('whtest', function () {
        api('/courier-accounts/' + encodeURIComponent(accountId) + '/webhook/test-event',
          { method: 'POST', body: {} })
          .then(function () { toast('Test event sent'); refresh(); }).catch(fail);
      });
      on('whsecret', function () {
        api('/courier-accounts/' + encodeURIComponent(accountId) + '/webhook/secret',
          { method: 'POST', body: {} })
          .then(function (r) {
            // The plaintext secret is returned exactly once (§5.7) — show it
            // in a form the merchant can copy before it becomes unreadable.
            var secret = r && (r.secret || r.webhookSecret);
            closeModal();
            if (secret) {
              modal('New signing secret',
                '<p>Copy this now — it cannot be shown again.</p>' +
                '<input class="input mono" readonly style="width:100%;font-size:12px" value="' +
                  h(secret) + '" />' +
                '<p class="note">Give it to ' + h(courier.name) + ' so their events are signed with it.</p>',
                '<div class="spacer"></div><button class="btn primary" data-close>Done</button>');
            } else { toast('Secret regenerated'); }
            if (onDone) onDone();
          }).catch(fail);
      });
      on('whtoken', function () {
        api('/courier-accounts/' + encodeURIComponent(accountId) + '/webhook/url-token',
          { method: 'POST', body: {} })
          .then(function () { toast('Webhook URL regenerated — update it with the courier'); refresh(); })
          .catch(fail);
      });

      back.addEventListener('click', function (e) {
        var el = e.target instanceof Element ? e.target : null;
        var svc = el && el.closest('[data-svc]');
        if (!svc) return;
        var turningOn = svc.getAttribute('data-on') !== '1';
        svc.disabled = true;
        api('/courier-accounts/' + encodeURIComponent(accountId) + '/services', {
          method: 'PUT',
          body: { serviceId: svc.getAttribute('data-svc'), enabled: turningOn },
        }).then(function () {
          svc.disabled = false;
          svc.setAttribute('data-on', turningOn ? '1' : '0');
          svc.textContent = turningOn ? 'Enabled' : 'Disabled';
          toast(turningOn ? 'Service enabled' : 'Service disabled');
        }).catch(function (e2) { svc.disabled = false; fail(e2); });
      });

      var rep = back.querySelector('#doreplace');
      if (rep) rep.addEventListener('click', function () {
        var form = back.querySelector('#credform');
        if (form && !form.reportValidity()) return;
        rep.disabled = true;
        rep.innerHTML = '<span class="spin"></span> Replacing';
        api('/courier-accounts/' + encodeURIComponent(accountId) + '/credentials',
          { method: 'POST', body: { credentials: collectCredentials(back) } })
          .then(function () { toast('Credentials replaced'); refresh(); })
          .catch(function (e) { rep.disabled = false; rep.textContent = 'Replace credentials'; fail(e); });
      });
    }).catch(fail);
  }

  function screenSettings() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Settings</h1></div>' + loading();

    Promise.all([
      api('/store-settings').catch(function (e) { return { __err: e }; }),
      api('/team/members').catch(function () { return null; }),
    ]).then(function (res) {
      var s = res[0] || {};
      var team = res[1];
      var members = team ? (Array.isArray(team) ? team : team.members || team.items || []) : [];

      var memberRows = members.map(function (m) {
        /* Identify a person by something a human recognises. The member_id is
           an internal UUID — for a Shopify staff member the staff user id is
           what appears in Shopify's own admin, and email when we have it. */
        var who = m.email || m.shopify_staff_user_id || m.shopifyStaffUserId;
        var id = m.memberId || m.member_id || '';
        return '<tr><td>' + (who
            ? '<strong>' + h(who) + '</strong>'
            : '<span class="mono muted">' + h(id.slice(0, 8)) + '</span>') +
          (m.revoked_at || m.revokedAt ? ' <span class="badge bad">Revoked</span>' : '') + '</td>' +
          '<td>' + stateBadge(m.role) + '</td>' +
          '<td>' + h(titleCase(m.authSource || m.auth_source || '')) + '</td>' +
          '<td class="muted">' + h(m.lastActiveAt || m.last_active_at
            ? dateTime(m.lastActiveAt || m.last_active_at) : 'never') + '</td></tr>';
      }).join('');

      view.innerHTML =
        '<div class="page-head"><h1>Settings</h1></div>' +
        '<div class="stack">' +
          '<div class="card"><div class="card-head"><h2>Store</h2></div><div class="card-body">' +
            (s.__err
              ? '<div class="banner warn"><div>Could not load store settings: ' +
                h(s.__err.message) + '</div></div>'
              : '<dl class="kv">' +
                  '<dt>Timezone</dt><dd>' + h(s.timezone || '—') + '</dd>' +
                  '<dt>Currency</dt><dd>INR</dd>' +
                  (s.weightUnit ? '<dt>Weight unit</dt><dd>' + h(s.weightUnit) + '</dd>' : '') +
                '</dl>') +
          '</div></div>' +
          '<div class="card"><div class="card-head"><h2>Team</h2><div class="spacer"></div>' +
            '<span class="muted" style="font-size:12.5px">' + num(members.length) + ' member(s)</span></div>' +
            '<div class="card-body flush">' +
            (memberRows ? '<div class="table-wrap"><table class="data"><thead><tr>' +
              '<th>Member</th><th>Role</th><th>Auth</th><th>Last active</th>' +
              '</tr></thead><tbody>' + memberRows + '</tbody></table></div>'
                        : empty('No team members visible', 'Requires the team.manage permission.')) +
            '</div></div>' +
        '</div>';
    });
  }

  // §9.8 NDR inbox. Aging matters operationally, so it is computed and shown.
  var screenNdr = simpleScreen({
    title: 'NDR',
    subtitle: 'Non-delivery cases',
    tableTitle: 'Open cases',
    endpoint: '/ndr/inbox',
    viewAware: true,
    emptyTitle: 'No NDR cases',
    emptySub: 'Cases appear when a courier reports a failed delivery attempt.',
    columns: [
      { label: 'AWB', cell: function (r) {
        return '<span class="mono">' + h(r.awb_normalized || r.awb || '—') + '</span>' +
          testMarker(r.is_test); } },
      { label: 'Reason', cell: function (r) { return stateBadge(r.reason_code || r.reason); } },
      { label: 'State', cell: function (r) { return stateBadge(r.state); } },
      { label: 'Attempts', num: true, cell: function (r) { return num(r.attempt_count); } },
      { label: 'Aging', num: true, cell: function (r) {
        var first = r.first_ndr_at || r.firstNdrAt;
        if (!first) return '—';
        var days = Math.floor((Date.now() - new Date(first).getTime()) / 86400000);
        // Aging drives the §9.8 follow-up ladder, so old cases are marked.
        var tone = days >= 3 ? 'bad' : days >= 1 ? 'warn' : '';
        return '<span class="badge ' + tone + '">' + days + 'd</span>'; } },
      { label: 'First reported', cell: function (r) {
        return '<span class="muted">' + h(dateTime(r.first_ndr_at)) + '</span>'; } },
    ],
  });

  // §9.4 rules. Order is the whole semantics — first match wins — so priority
  // leads the table and the natural sort is preserved.
  var screenRules = simpleScreen({
    title: 'Shipping rules',
    subtitle: 'Evaluated in order; the first match wins',
    tableTitle: 'Rules',
    endpoint: '/rules',
    emptyTitle: 'No rules yet',
    emptySub: 'Without a rule, allocation falls back to the stored selection.',
    columns: [
      { label: '#', num: true, cell: function (r) {
        return num(r.priority !== undefined ? r.priority : r.position); } },
      { label: 'Name', cell: function (r) {
        return '<strong>' + h(r.name || '—') + '</strong>'; } },
      { label: 'Status', cell: function (r) {
        var on = r.isActive !== undefined ? r.isActive : r.is_active;
        return on ? '<span class="badge ok">Active</span>'
                  : '<span class="badge">Paused</span>'; } },
      { label: 'Updated', cell: function (r) {
        return '<span class="muted">' + h(dateTime(r.updatedAt || r.updated_at)) + '</span>'; } },
    ],
  });

  var screenRateCards = simpleScreen({
    title: 'Rate cards',
    subtitle: 'Your negotiated courier pricing',
    tableTitle: 'Cards',
    endpoint: '/rate-cards',
    emptyTitle: 'No rate cards',
    emptySub: 'Without a rate card the engine falls back to live courier quotes.',
    columns: [
      { label: 'Name', cell: function (r) {
        return '<strong>' + h(r.name || r.code || '—') + '</strong>'; } },
      { label: 'Courier', cell: function (r) {
        return h(titleCase(r.courierCode || r.courier_code || '—')); } },
      { label: 'Status', cell: function (r) {
        return stateBadge(r.state || (r.isSealed || r.is_sealed ? 'SEALED' : 'DRAFT')); } },
      { label: 'Updated', cell: function (r) {
        return '<span class="muted">' + h(dateTime(r.updatedAt || r.updated_at)) + '</span>'; } },
    ],
  });

  var screenInvoices = simpleScreen({
    title: 'GST invoices',
    tableTitle: 'Invoices',
    endpoint: '/gst/invoices',
    emptyTitle: 'No invoices',
    emptySub: 'Invoices are issued against booked shipments.',
    columns: [
      { label: 'Number', mono: true, cell: function (r) {
        return h(r.invoiceNumber || r.invoice_number || '—'); } },
      { label: 'State', cell: function (r) { return stateBadge(r.state); } },
      { label: 'Taxable', num: true, cell: function (r) {
        return money(r.taxableValue || r.taxable_value); } },
      { label: 'Total', num: true, cell: function (r) {
        return money(r.totalValue || r.total_value || r.total); } },
      { label: 'Issued', cell: function (r) {
        return '<span class="muted">' + h(dateTime(r.issuedAt || r.issued_at)) + '</span>'; } },
    ],
  });

  var screenReports = simpleScreen({
    title: 'Reports',
    subtitle: 'Exports you have requested',
    tableTitle: 'Recent jobs',
    endpoint: '/reports/jobs',
    emptyTitle: 'No reports run yet',
    emptySub: 'Run a report to export orders, shipments or reconciliation data.',
    columns: [
      { label: 'Report', cell: function (r) {
        return '<strong>' + h(titleCase(r.report_code || r.reportCode || '—')) + '</strong>'; } },
      { label: 'State', cell: function (r) { return stateBadge(r.state); } },
      { label: 'Rows', num: true, cell: function (r) {
        var n = r.row_count !== undefined ? r.row_count : r.rowCount;
        return n === null || n === undefined ? '—' : num(n); } },
      { label: 'As of', cell: function (r) {
        return '<span class="muted">' + h(dateTime(r.as_of_at || r.asOfAt)) + '</span>'; } },
      { label: '', cell: function (r) {
        var id = r.report_job_id || r.reportJobId;
        var done = String(r.state || '').toUpperCase() === 'READY' ||
                   String(r.state || '').toUpperCase() === 'COMPLETED';
        // The download URL is signed and expiring (S-26); let the browser
        // follow it rather than fetching it through the API layer.
        return done && id
          ? '<a class="btn sm" href="/reports/jobs/' + h(id) + '/download">Download</a>'
          : ''; } },
    ],
  });

  var screenReconFreight = simpleScreen({
    title: 'Freight reconciliation',
    subtitle: 'Courier invoices matched against booked shipments',
    tableTitle: 'Batches',
    endpoint: '/recon/freight/batches',
    emptyTitle: 'No freight batches',
    emptySub: 'Upload a courier invoice to reconcile it against your shipments.',
    columns: [
      { label: 'Batch', mono: true, cell: function (r) {
        return h((r.reconBatchId || r.recon_batch_id || '').slice(0, 8) || '—'); } },
      { label: 'Courier', cell: function (r) {
        return h(titleCase(r.courierCode || r.courier_code || '—')); } },
      { label: 'State', cell: function (r) { return stateBadge(r.state); } },
      { label: 'Control total', cell: function (r) {
        // §3.28 MISMATCH is the headline: the batch cannot be trusted.
        return stateBadge(r.controlTotalState || r.control_total_state); } },
      { label: 'Rows', num: true, cell: function (r) {
        return num(r.rowCount !== undefined ? r.rowCount : r.row_count); } },
      { label: 'Uploaded', cell: function (r) {
        return '<span class="muted">' + h(dateTime(r.createdAt || r.created_at)) + '</span>'; } },
    ],
  });

  var screenReconCod = simpleScreen({
    title: 'COD reconciliation',
    subtitle: 'Remittances matched against collectible amounts',
    tableTitle: 'Batches',
    endpoint: '/recon/cod/batches',
    emptyTitle: 'No COD batches',
    emptySub: 'Upload a courier remittance statement to reconcile it.',
    columns: [
      { label: 'Batch', mono: true, cell: function (r) {
        return h((r.reconBatchId || r.recon_batch_id || '').slice(0, 8) || '—'); } },
      { label: 'Courier', cell: function (r) {
        return h(titleCase(r.courierCode || r.courier_code || '—')); } },
      { label: 'State', cell: function (r) { return stateBadge(r.state); } },
      { label: 'Remitted', num: true, cell: function (r) {
        return money(r.remittedAmount || r.remitted_amount); } },
      { label: 'Uploaded', cell: function (r) {
        return '<span class="muted">' + h(dateTime(r.createdAt || r.created_at)) + '</span>'; } },
    ],
  });

  function screenBilling() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Plan &amp; billing</h1></div>' + loading();

    Promise.all([
      api('/billing/subscription').catch(function (e) { return { __err: e }; }),
      api('/billing/history').catch(function () { return null; }),
    ]).then(function (res) {
      var sub = res[0] || {};
      var history = unwrap(res[1]);

      // The endpoint returns { subscription, plan } — not a flat object.
      var s = sub.subscription || sub;
      var plan = sub.plan || {};

      var subCard = sub.__err
        ? '<div class="card"><div class="card-body">' +
          (sub.__err.status === 403
            ? empty('Not available for your role', 'Billing needs the billing.manage permission (§10.2).')
            : '<div class="banner warn"><div>' + h(sub.__err.message) + '</div></div>') +
          '</div></div>'
        : '<div class="card"><div class="card-head"><h2>Subscription</h2></div>' +
          '<div class="card-body"><dl class="kv">' +
            '<dt>State</dt><dd>' + stateBadge(s.state) + '</dd>' +
            '<dt>Plan</dt><dd>' + h(plan.name || plan.code || '—') + '</dd>' +
            '<dt>Cycle</dt><dd>' +
              (s.cycle_start_at || s.cycleStartAt
                ? h(dateTime(s.cycle_start_at || s.cycleStartAt)) + ' → ' +
                  h(dateTime(s.cycle_end_at || s.cycleEndAt))
                : '<span class="muted">—</span>') + '</dd>' +
            '<dt>Currency</dt><dd>' + h(s.currency || 'INR') + '</dd>' +
            (s.capped_amount || s.cappedAmount
              ? '<dt>Capped amount</dt><dd class="money">' +
                money(s.capped_amount || s.cappedAmount) + '</dd>' : '') +
          '</dl></div></div>';

      var rows = history.map(function (r) {
        return '<tr><td>' + h(titleCase(r.kind || r.type || 'Charge')) + '</td>' +
          '<td class="num money">' + money(r.amount) + '</td>' +
          '<td>' + stateBadge(r.state) + '</td>' +
          '<td class="muted">' + h(dateTime(r.createdAt || r.created_at)) + '</td></tr>';
      }).join('');

      view.innerHTML = '<div class="page-head"><h1>Plan &amp; billing</h1></div>' +
        '<div class="stack">' + subCard +
        '<div class="card"><div class="card-head"><h2>History</h2></div>' +
        '<div class="card-body flush">' +
        (rows ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Item</th><th class="num">Amount</th><th>State</th><th>Date</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
              : empty('No charges yet')) +
        '</div></div></div>';
    });
  }

  // ADD-29/30 setup health: what is still unconfigured, and what it blocks.
  function screenSetup() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Setup</h1></div>' + loading();

    api('/setup/health').then(function (d) {
      // ADD-29/30 shape: { completed, items: [{ itemKey, label, fixPath,
      // state: OK|MISSING|BROKEN, detail }] }.
      var items = unwrap(d);
      var outstanding = items.filter(function (c) { return c.state !== 'OK'; });

      var rows = items.map(function (c) {
        /* MISSING and BROKEN are different problems — one was never
           configured, the other is configured and failing — so they do not
           share a badge. Collapsing them would hide the more urgent one. */
        var badge = c.state === 'OK' ? '<span class="badge ok">Ready</span>'
                  : c.state === 'BROKEN' ? '<span class="badge bad">Broken</span>'
                  : '<span class="badge warn">Not set up</span>';
        // The service defaults detail to "Not yet evaluated." even for OK
        // items; showing that under a green badge reads as a contradiction.
        var detail = c.state !== 'OK' && c.detail && c.detail !== 'Not yet evaluated.'
          ? '<div class="muted" style="font-size:12.5px;margin-top:2px">' + h(c.detail) + '</div>'
          : '';
        var fix = c.state !== 'OK' && c.fixPath
          ? '<a class="btn sm" href="#' + h(c.fixPath) + '">Fix</a>'
          : '';
        return '<tr><td><strong>' + h(c.label || c.itemKey || '—') + '</strong>' + detail +
          '</td><td>' + badge + '</td><td style="text-align:right">' + fix + '</td></tr>';
      }).join('');

      var banner = items.length === 0 ? ''
        : outstanding.length === 0
          ? '<div class="banner" style="background:var(--ok-bg);color:var(--ok-fg);border-color:currentColor;margin-bottom:16px">' +
            '<div><strong>Setup complete.</strong> Every check is ready.</div></div>'
          : '<div class="banner warn" style="margin-bottom:16px"><div><strong>' +
            outstanding.length + ' of ' + items.length + ' checks need attention.</strong><br>' +
            'Shipments can still be booked, but these gaps cause failures later.</div></div>';

      view.innerHTML = '<div class="page-head"><h1>Setup</h1>' +
        '<span class="muted">What is still needed before you can ship</span></div>' +
        banner +
        '<div class="card"><div class="card-body flush">' +
        (rows ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Check</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
              : empty('Nothing to configure', 'Setup health reports no outstanding items.')) +
        '</div></div>';
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Setup</h1></div>' + errorCard(err);
    });
  }

  // ─── Announcements (§9.19) ────────────────────────────────────────────

  /**
   * Header bell + dismissible banner. Both are best-effort: a merchant whose
   * role lacks tickets.use still gets a working console, just no bell count,
   * so failures here are swallowed rather than surfaced as errors.
   */
  function refreshAnnouncements() {
    api('/support/announcements/unread-count').then(function (r) {
      var n = typeof r === 'number' ? r : (r && (r.count !== undefined ? r.count : r.unread)) || 0;
      var el = document.getElementById('bellcount');
      if (!el) return;
      el.innerHTML = n > 0
        ? '<span style="position:absolute;top:-5px;right:-5px;background:var(--bad-fg);color:#fff;' +
          'border-radius:999px;font-size:10.5px;font-weight:700;min-width:16px;height:16px;' +
          'display:inline-flex;align-items:center;justify-content:center;padding:0 4px">' +
          h(n > 9 ? '9+' : String(n)) + '</span>'
        : '';
    }).catch(function () { /* role may lack tickets.use */ });

    api('/support/announcements/banner').then(function (b) {
      var a = b && (b.announcement || b);
      if (!a || !a.announcement_id) return;
      showBanner(a);
    }).catch(function () { /* no banner is the normal case */ });
  }

  function showBanner(a) {
    if (document.getElementById('annbanner')) return;
    var content = document.getElementById('annhost');
    if (!content) return;
    var tone = a.type === 'WARNING' ? 'warn' : '';
    var el = document.createElement('div');
    el.id = 'annbanner';
    el.className = 'banner ' + tone;
    el.style.cssText = 'margin-bottom:16px;align-items:flex-start';
    el.innerHTML =
      (a.image_url
        // The URL is http(s)-validated server-side; still rendered as a plain
        // img with no interpolation into an attribute the browser executes.
        ? '<img src="' + h(a.image_url) + '" alt="" style="width:64px;height:64px;' +
          'object-fit:cover;border-radius:var(--r-sm);flex:0 0 auto" />'
        : '') +
      '<div style="flex:1">' +
        '<strong>' + h(a.title) + '</strong><br>' +
        '<span style="white-space:pre-wrap">' + h(a.body) + '</span>' +
      '</div>' +
      '<button class="btn sm" data-dismiss="' + h(a.announcement_id) + '">Dismiss</button>';
    content.appendChild(el);

    el.querySelector('[data-dismiss]').addEventListener('click', function () {
      api('/support/announcements/' + encodeURIComponent(a.announcement_id) + '/dismiss',
        { method: 'POST', body: {} })
        .catch(function () {})
        .then(function () { el.remove(); refreshAnnouncements(); });
    });
  }

  function openAnnouncements() {
    var back = modal('Announcements',
      '<div style="display:grid;place-items:center;padding:26px"><span class="spin"></span></div>',
      '<div class="spacer"></div><button class="btn" data-close>Close</button>');

    api('/support/announcements').then(function (payload) {
      var rows = unwrap(payload).length ? unwrap(payload) : (payload || []);
      if (!Array.isArray(rows)) rows = [];

      var body = rows.length ? rows.map(function (a) {
        var unread = !a.read_at;
        return '<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)">' +
          (a.image_url
            ? '<img src="' + h(a.image_url) + '" alt="" style="width:56px;height:56px;' +
              'object-fit:cover;border-radius:var(--r-sm);flex:0 0 auto" />'
            : '') +
          '<div style="flex:1;min-width:0">' +
            '<div class="row" style="gap:8px">' +
              '<strong>' + h(a.title) + '</strong>' +
              (a.type === 'WARNING' ? '<span class="badge bad">Warning</span>'
                : a.type === 'UPDATE' ? '<span class="badge info">Update</span>' : '') +
              (unread ? '<span class="badge">New</span>' : '') +
            '</div>' +
            '<div style="white-space:pre-wrap;margin-top:4px">' + h(a.body) + '</div>' +
            '<div class="muted" style="font-size:12px;margin-top:4px">' +
              h(dateTime(a.published_at)) + '</div>' +
          '</div></div>';
      }).join('') : empty('No announcements', 'Product news and notices appear here.');

      back.querySelector('.modal-body').innerHTML = body;
      // Opening the list is the read receipt — dismissing every item clears
      // the badge, which is what a merchant expects from a bell.
      rows.filter(function (a) { return !a.read_at; }).forEach(function (a) {
        api('/support/announcements/' + encodeURIComponent(a.announcement_id) + '/dismiss',
          { method: 'POST', body: {} }).catch(function () {});
      });
      setTimeout(refreshAnnouncements, 400);
    }).catch(function (err) {
      back.querySelector('.modal-body').innerHTML = err.status === 403
        ? empty('Not available for your role', 'Announcements need the tickets.use permission (§10.2).')
        : '<div class="banner bad"><div>' + h(err.message) + '</div></div>';
    });
  }

  // ─── Support (§9.18) ──────────────────────────────────────────────────

  var ATTACH_MAX_BYTES = 10 * 1024 * 1024;
  var ATTACH_MAX_FILES = 5;

  /**
   * Uploads the picked files and returns the {key, bytes} refs the ticket
   * endpoints expect. Uploading first means a failed file is reported before
   * the merchant has written a message, not after.
   */
  function uploadFiles(input, statusEl) {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return Promise.resolve([]);
    if (files.length > ATTACH_MAX_FILES) {
      return Promise.reject(new Error('At most ' + ATTACH_MAX_FILES + ' files per message.'));
    }
    var tooBig = files.filter(function (f) { return f.size > ATTACH_MAX_BYTES; });
    if (tooBig.length) {
      return Promise.reject(new Error(tooBig[0].name + ' is larger than 10 MB.'));
    }
    if (statusEl) statusEl.textContent = 'Uploading ' + files.length + ' file(s)…';

    return Promise.all(files.map(function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onerror = function () { reject(new Error('Could not read ' + file.name)); };
        r.onload = function () {
          // readAsDataURL gives "data:<type>;base64,<payload>" — the API wants
          // only the payload.
          var b64 = String(r.result).split(',')[1] || '';
          api('/support/attachments', {
            method: 'POST',
            body: { filename: file.name, dataBase64: b64 },
          }).then(resolve, function (e) {
            var b = e.body || {};
            reject(new Error(file.name + ': ' + (b.message || e.message)));
          });
        };
        r.readAsDataURL(file);
      });
    })).then(function (refs) {
      if (statusEl) statusEl.textContent = '';
      return refs;
    });
  }

  function filePicker(id) {
    return '<div><label for="' + id + '">Attachments <span class="muted">(optional)</span></label>' +
      '<input class="input" type="file" id="' + id + '" multiple style="width:100%" ' +
        'accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.csv,.txt,.xls,.xlsx" />' +
      '<div class="muted" style="font-size:12px;margin-top:3px">' +
        'Up to 5 files, 10 MB each. Images, PDF, CSV or spreadsheets.</div></div>';
  }

  /** Attachment chips under a message. Images preview inline. */
  function renderAttachments(list) {
    var items = Array.isArray(list) ? list : [];
    if (!items.length) return '';
    return '<div class="row" style="gap:8px;margin-top:8px">' + items.map(function (a) {
      var url = '/support/attachments?key=' + encodeURIComponent(a.key);
      var name = a.filename || String(a.key).split('/').pop();
      var isImage = /.(png|jpe?g|gif|webp)$/i.test(a.key || '');
      return isImage
        ? '<a href="' + h(url) + '" target="_blank" rel="noopener" title="' + h(name) + '">' +
          '<img src="' + h(url) + '" alt="' + h(name) + '" style="width:64px;height:64px;' +
          'object-fit:cover;border-radius:var(--r-sm);border:1px solid var(--border)" /></a>'
        : '<a class="btn sm" href="' + h(url) + '" target="_blank" rel="noopener">📎 ' +
          h(name) + '</a>';
    }).join('') + '</div>';
  }
  var TICKET_CATEGORIES = ['COURIER_ISSUE', 'BILLING', 'BUG', 'FEATURE', 'OTHER'];
  var TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

  function screenSupport() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Support</h1></div>' + loading();

    api('/support/tickets').then(function (payload) {
      var rows = unwrap(payload).length ? unwrap(payload) : (payload || []);
      if (!Array.isArray(rows)) rows = [];

      var body = rows.length
        ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>#</th><th>Subject</th><th>Category</th><th>Priority</th><th>State</th><th>Raised</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (t) {
            var id = t.ticketId || t.ticket_id;
            return '<tr>' +
              '<td class="mono">' + h(t.number || '—') + '</td>' +
              '<td><a class="row-link" href="#/support/' + h(id) + '">' +
                h(t.subject || '—') + '</a></td>' +
              '<td>' + h(titleCase(t.category)) + '</td>' +
              '<td>' + stateBadge(t.priority) + '</td>' +
              '<td>' + stateBadge(t.state) + '</td>' +
              '<td class="muted">' + h(dateTime(t.createdAt || t.created_at)) + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No tickets yet', 'Raise one and our support team will pick it up.');

      view.innerHTML = '<div class="page-head"><h1>Support</h1><div class="spacer"></div>' +
        '<button class="btn primary" id="newticket">New ticket</button></div>' +
        '<div class="card"><div class="card-head"><h2>Your tickets</h2><div class="spacer"></div>' +
        '<span class="muted" style="font-size:12.5px">' + num(rows.length) + '</span></div>' +
        '<div class="card-body flush">' + body + '</div></div>';

      document.getElementById('newticket').addEventListener('click', function () {
        openNewTicket(screenSupport);
      });
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Support</h1></div>' +
        (err.status === 403
          ? '<div class="card"><div class="card-body">' +
            empty('Not available for your role', 'Support needs the tickets.use permission (§10.2).') +
            '</div></div>'
          : errorCard(err));
    });
  }

  function openNewTicket(onDone) {
    var back = modal('New support ticket',
      '<form id="tf" style="display:grid;gap:12px">' +
        '<div><label for="tcat">Category</label>' +
          '<select class="input" id="tcat" style="width:100%">' +
          TICKET_CATEGORIES.map(function (c) {
            return '<option value="' + h(c) + '">' + h(titleCase(c)) + '</option>';
          }).join('') + '</select></div>' +
        '<div><label for="tpri">Priority</label>' +
          '<select class="input" id="tpri" style="width:100%">' +
          TICKET_PRIORITIES.map(function (p) {
            return '<option value="' + h(p) + '"' + (p === 'NORMAL' ? ' selected' : '') + '>' +
              h(titleCase(p)) + '</option>';
          }).join('') + '</select></div>' +
        '<div><label for="tsub">Subject</label>' +
          '<input class="input" id="tsub" maxlength="500" required style="width:100%" ' +
            'placeholder="Short summary" /></div>' +
        '<div><label for="tdesc">What happened?</label>' +
          '<textarea class="input" id="tdesc" required rows="6" style="width:100%;resize:vertical" ' +
            'placeholder="Include an order number or AWB if it relates to one."></textarea></div>' +
        '<div><label for="tawb">Related AWB <span class="muted">(optional)</span></label>' +
          '<input class="input" id="tawb" style="width:100%" placeholder="e.g. DL10007919" /></div>' +
        filePicker('tfiles') +
      '</form>',
      '<span id="tmsg" class="muted"></span><div class="spacer"></div>' +
      '<button class="btn" data-close>Cancel</button>' +
      '<button class="btn primary" id="tsend">Raise ticket</button>');

    back.querySelector('#tsend').addEventListener('click', function () {
      var form = back.querySelector('#tf');
      if (!form.reportValidity()) return;
      var btn = back.querySelector('#tsend');
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Sending';

      var body = {
        category: back.querySelector('#tcat').value,
        priority: back.querySelector('#tpri').value,
        subject: back.querySelector('#tsub').value.trim(),
        description: back.querySelector('#tdesc').value.trim(),
      };
      // Only send the link when given — an empty string would fail validation.
      var awb = back.querySelector('#tawb').value.trim();
      if (awb) body.linkedAwb = awb;

      uploadFiles(back.querySelector('#tfiles'), back.querySelector('#tmsg')).then(function (refs) {
        if (refs.length) body.attachments = refs;
        return api('/support/tickets', { method: 'POST', body: body });
      }).then(function (t) {
        closeModal();
        toast('Ticket raised' + (t && t.number ? ' · ' + t.number : ''));
        if (onDone) onDone();
      }).catch(function (err) {
        if (err.message === 'unauthenticated') return;
        btn.disabled = false;
        btn.textContent = 'Raise ticket';
        var b = err.body || {};
        var msg = Array.isArray(b.message) ? b.message.join(' · ') : (b.message || err.message);
        back.querySelector('#tmsg').innerHTML =
          '<span style="color:var(--bad-fg)">' + h(String(msg)) + '</span>';
      });
    });
  }

  /** The conversation. Merchants reply here until the ticket is closed. */
  function screenTicketThread(ticketId) {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Ticket</h1></div>' + loading();

    api('/support/tickets/' + encodeURIComponent(ticketId)).then(function (d) {
      var t = d.ticket || d;
      var messages = d.messages || d.thread || [];

      var bubbles = messages.length ? messages.map(function (m) {
        var mine = (m.authorKind || m.author_kind) === 'MEMBER';
        return '<div style="display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start') + ';margin-bottom:10px">' +
          '<div style="max-width:min(72%,560px);padding:10px 13px;border-radius:var(--r-md);' +
            'background:' + (mine ? 'var(--petrol-700);color:#fff' : 'var(--surface-sunk)') + '">' +
            '<div style="font-size:11.5px;opacity:.75;margin-bottom:3px">' +
              h(mine ? 'You' : 'Jsyxi support') + ' · ' +
              h(dateTime(m.createdAt || m.created_at)) + '</div>' +
            '<div style="white-space:pre-wrap">' + h(m.body || '') + '</div>' +
            renderAttachments(m.attachments) +
          '</div></div>';
      }).join('') : empty('No messages');

      // §3.16: a CLOSED ticket is not a conversation any more.
      var closed = t.state === 'CLOSED';

      view.innerHTML =
        '<div class="page-head"><a class="btn sm" href="#/support">← Support</a>' +
          '<h1>' + h(t.subject || 'Ticket') + '</h1>' + stateBadge(t.state) + stateBadge(t.priority) +
        '</div>' +
        '<div class="stack">' +
          '<div class="card"><div class="card-body"><dl class="kv">' +
            '<dt>Ticket</dt><dd class="mono">' + h(t.number || '—') + '</dd>' +
            '<dt>Category</dt><dd>' + h(titleCase(t.category)) + '</dd>' +
            '<dt>Raised</dt><dd>' + h(dateTime(t.createdAt || t.created_at)) + '</dd>' +
            (t.linkedAwb || t.linked_awb
              ? '<dt>Related AWB</dt><dd class="mono">' + h(t.linkedAwb || t.linked_awb) + '</dd>' : '') +
          '</dl></div></div>' +
          '<div class="card"><div class="card-head"><h2>Conversation</h2></div>' +
            '<div class="card-body">' + bubbles + '</div>' +
            (closed
              ? '<div class="pager"><span class="muted">This ticket is closed.</span></div>'
              : '<div class="card-body" style="border-top:1px solid var(--border)">' +
                '<textarea class="input" id="reply" rows="3" style="width:100%;resize:vertical" ' +
                  'placeholder="Write a reply…"></textarea>' +
                '<div style="margin-top:8px">' + filePicker('rfiles') + '</div>' +
                '<div class="row" style="margin-top:8px"><span id="rmsg" class="muted"></span>' +
                '<div class="spacer" style="flex:1"></div>' +
                '<button class="btn primary" id="sendreply">Send reply</button></div>' +
                '</div>') +
          '</div>' +
        '</div>';

      var send = document.getElementById('sendreply');
      if (send) send.addEventListener('click', function () {
        var ta = document.getElementById('reply');
        var text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        send.disabled = true;
        send.innerHTML = '<span class="spin"></span> Sending';
        uploadFiles(document.getElementById('rfiles'), document.getElementById('rmsg'))
          .then(function (refs) {
            var payload = { body: text };
            if (refs.length) payload.attachments = refs;
            return api('/support/tickets/' + encodeURIComponent(ticketId) + '/messages',
              { method: 'POST', body: payload });
          })
          .then(function () { toast('Reply sent'); screenTicketThread(ticketId); })
          .catch(function (err) {
            if (err.message === 'unauthenticated') return;
            send.disabled = false; send.textContent = 'Send reply';
            var b = err.body || {};
            toast(String(b.message || err.message), true);
          });
      });
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><a class="btn sm" href="#/support">← Support</a>' +
        '<h1>Ticket</h1></div>' + errorCard(err);
    });
  }

  // ─── Router ───────────────────────────────────────────────────────────
  var ROUTES = {
    '': screenDashboard,
    'orders': function (arg) { return arg ? screenOrderDetail(arg) : screenOrders(); },
    'shipments': screenShipments,
    'ndr': screenNdr,
    'invoices': screenInvoices,
    'recon-freight': screenReconFreight,
    'recon-cod': screenReconCod,
    'billing': screenBilling,
    'rules': screenRules,
    'rate-cards': screenRateCards,
    'couriers': screenCouriers,
    'reports': screenReports,
    'setup': screenSetup,
    'support': function (arg) { return arg ? screenTicketThread(arg) : screenSupport(); },
    'settings': screenSettings,
  };

  function paint() {
    var route = currentRoute();
    root.innerHTML = shell(route);

    document.getElementById('bell').addEventListener('click', openAnnouncements);
    refreshAnnouncements();

    document.getElementById('theme').addEventListener('click', function () {
      localStorage.setItem(THEME_KEY, currentTheme() === 'dark' ? 'light' : 'dark');
      applyTheme();
      paint();
    });

    document.getElementById('logout').addEventListener('click', function () {
      api('/auth/logout', { method: 'POST' })
        .catch(function () { /* signing out locally regardless */ })
        .then(function () { window.location.href = '/'; });
    });

    Array.prototype.forEach.call(root.querySelectorAll('.seg button'), function (b) {
      b.addEventListener('click', function () {
        var next = b.getAttribute('data-view');
        if (next === state.view) return;
        state.view = next;
        localStorage.setItem(VIEW_KEY, next);
        toast(next === 'test' ? 'Showing test data' : 'Showing live data');
        paint();
      });
    });

    var handler = ROUTES[route.name];
    if (!handler) {
      document.getElementById('view').innerHTML =
        '<div class="card"><div class="card-body">' +
        empty('Page not found', 'That screen does not exist.') + '</div></div>';
      return;
    }
    handler(route.arg);
  }

  window.addEventListener('hashchange', paint);

  // Confirm the session before painting the shell: an expired cookie should
  // land on the entry flow, not on a console full of failed requests.
  api('/dashboard?view=live').then(function () {
    paint();
  }).catch(function (err) {
    if (err.message === 'unauthenticated') return;
    // Any other failure (e.g. a permission gap) still shows the console; the
    // individual screens surface their own errors.
    paint();
  });
})();
