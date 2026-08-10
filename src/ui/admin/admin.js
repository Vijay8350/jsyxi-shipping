/*
 * Jsyxi staff console (§9.13, §10.3).
 *
 * A DIFFERENT surface from the merchant console, not a privileged mode of it:
 * separate cookie (admin_session), separate login, separate audience. A
 * merchant session grants nothing here and vice versa — which is why this is a
 * second bundle rather than a role check inside the first.
 *
 * Served from /staff because /admin/* is the API.
 */
(function () {
  'use strict';

  var root = document.getElementById('root');
  var toastHost = document.getElementById('toasts');
  var me = null;

  function h(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { return (Number(v) || 0).toLocaleString('en-IN'); }
  function money(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    return isFinite(n) ? '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : h(v);
  }
  function dateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
  var ACRONYMS = { COD: 1, NDR: 1, RTO: 1, GST: 1, AWB: 1, SLA: 1, TAT: 1, DLQ: 1, ID: 1, API: 1 };
  function titleCase(s) {
    return String(s || '').split(/[_\s]+/).filter(Boolean).map(function (w) {
      var u = w.toUpperCase();
      return ACRONYMS[u] ? u : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  }
  function toast(msg, bad) {
    var el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    toastHost.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  var TONE = {
    ACTIVE: 'ok', HEALTHY: 'ok', RESOLVED: 'ok', CLOSED: 'ok', PUBLISHED: 'ok',
    TRIALING: 'info', OPEN: 'info', IN_PROGRESS: 'info', PENDING: 'warn',
    WAITING_ON_MERCHANT: 'warn', DEGRADED: 'warn', PAST_DUE: 'warn',
    SUSPENDED: 'bad', CANCELLED: 'bad', DISCONNECTED: 'bad', UNINSTALLED: 'bad', FROZEN: 'bad',
  };
  function badge(v) {
    if (!v) return '<span class="muted">—</span>';
    return '<span class="badge ' + (TONE[v] || '') + '">' + h(titleCase(v)) + '</span>';
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) { me = null; paintLogin(); throw new Error('unauthenticated'); }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var e = new Error((body && (body.message || body.status)) || ('HTTP ' + res.status));
          e.status = res.status; e.body = body; throw e;
        }
        return body;
      });
    });
  }

  function unwrap(p) {
    if (Array.isArray(p)) return p;
    if (!p || typeof p !== 'object') return [];
    var keys = ['items', 'rows', 'merchants', 'tickets', 'users', 'plans', 'data'];
    for (var i = 0; i < keys.length; i++) if (Array.isArray(p[keys[i]])) return p[keys[i]];
    return [];
  }

  // ─── Login ────────────────────────────────────────────────────────────
  function paintLogin(message) {
    root.innerHTML =
      '<div style="display:grid;place-items:center;min-height:100vh;padding:20px">' +
        '<div class="card" style="width:min(400px,100%)">' +
          '<div class="card-head"><h2>Jsyxi staff sign-in</h2></div>' +
          '<div class="card-body">' +
            (message ? '<div class="banner bad" style="margin-bottom:14px"><div>' + h(message) + '</div></div>' : '') +
            '<form id="lf" style="display:grid;gap:10px">' +
              '<label for="e">Email</label>' +
              '<input class="input" id="e" type="email" required autocomplete="username" />' +
              '<label for="p">Password</label>' +
              '<input class="input" id="p" type="password" required autocomplete="current-password" />' +
              '<label for="t">Authenticator code <span class="muted">(if enrolled)</span></label>' +
              '<input class="input" id="t" inputmode="numeric" pattern="\\d{6}" maxlength="6" ' +
                'autocomplete="one-time-code" placeholder="123456" />' +
              '<button class="btn primary" type="submit" style="margin-top:6px">Sign in</button>' +
            '</form>' +
            '<p class="muted" style="font-size:12.5px;margin-bottom:0">' +
              'Staff access only. Merchant accounts sign in at ' +
              '<a href="/">the app</a>.</p>' +
          '</div></div></div>';

    document.getElementById('lf').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = ev.target.querySelector('button');
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Signing in';
      var body = {
        email: document.getElementById('e').value.trim(),
        password: document.getElementById('p').value,
      };
      var t = document.getElementById('t').value.trim();
      if (t) body.totpCode = t;

      fetch('/admin/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (b) {
          if (!res.ok) throw new Error(b.message || b.status || ('Sign-in failed (' + res.status + ')'));
          return b;
        });
      }).then(function (ctx) { me = ctx; paint(); })
        .catch(function (err) {
          /* §10.3 requires TOTP for every admin, so a fresh account is refused
             until it enrols. Bouncing them back to the same form with an error
             they cannot act on would be a dead end — hand them the enrolment
             step instead. */
          if (/enrol/i.test(err.message)) {
            paintEnroll(body.email, body.password);
            return;
          }
          paintLogin(err.message);
        });
    });
  }

  /** First-run TOTP enrolment (§10.3). */
  function paintEnroll(email, password, message) {
    root.innerHTML =
      '<div style="display:grid;place-items:center;min-height:100vh;padding:20px">' +
        '<div class="card" style="width:min(440px,100%)">' +
          '<div class="card-head"><h2>Set up two-factor authentication</h2></div>' +
          '<div class="card-body">' +
            '<p class="muted" style="margin-top:0">Staff accounts require an authenticator ' +
              'app (§10.3). This is a one-time setup for <strong>' + h(email) + '</strong>.</p>' +
            (message ? '<div class="banner bad" style="margin-bottom:14px"><div>' + h(message) + '</div></div>' : '') +
            '<div id="uri"><span class="spin"></span> Generating your secret…</div>' +
          '</div></div></div>';

    fetch('/admin/auth/totp/enroll', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw new Error(b.message || 'Could not start enrolment');
        return b;
      });
    }).then(function (b) {
      // The otpauth URI carries the secret; pull it out so it can be typed in
      // by hand when scanning is not possible.
      var secret = (b.otpauthUri.match(/[?&]secret=([^&]+)/) || [])[1] || '';
      document.getElementById('uri').innerHTML =
        '<label>1. Add this to your authenticator app</label>' +
        '<input class="input mono" readonly style="width:100%;font-size:12px;margin:6px 0 4px" value="' +
          h(b.otpauthUri) + '" />' +
        '<p class="note" style="margin-top:0">Or enter the key manually: <strong class="mono">' +
          h(secret) + '</strong></p>' +
        '<form id="cf" style="display:grid;gap:10px;margin-top:14px">' +
          '<label for="c">2. Enter the 6-digit code it shows</label>' +
          '<input class="input" id="c" inputmode="numeric" pattern="\\d{6}" maxlength="6" required ' +
            'autocomplete="one-time-code" placeholder="123456" />' +
          '<button class="btn primary" type="submit">Confirm and sign in</button>' +
        '</form>';

      document.getElementById('cf').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var btn = ev.target.querySelector('button');
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> Confirming';
        var code = document.getElementById('c').value.trim();
        fetch('/admin/auth/totp/confirm', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password, code: code }),
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (b2) {
            throw new Error(b2.message || 'Invalid code');
          });
          // Enrolment done — complete the sign-in with the same code.
          return fetch('/admin/auth/login', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password, totpCode: code }),
          }).then(function (r2) {
            return r2.json().then(function (b3) {
              if (!r2.ok) throw new Error(b3.message || 'Sign-in failed');
              return b3;
            });
          });
        }).then(function (ctx) { me = ctx; toast('Two-factor enabled'); paint(); })
          .catch(function (e) { paintEnroll(email, password, e.message); });
      });
    }).catch(function (e) { paintLogin(e.message); });
  }

  // ─── Shell ────────────────────────────────────────────────────────────
  var NAV = [
    { section: 'Platform' },
    { id: '', icon: '◧', label: 'Overview' },
    { id: 'merchants', icon: '▤', label: 'Merchants' },
    { id: 'tickets', icon: '✉', label: 'Support tickets' },
    { id: 'announcements', icon: '📢', label: 'Announcements' },
    { section: 'Operations' },
    { id: 'monitors', icon: '⚠', label: 'Monitors' },
    { id: 'dlq', icon: '⟲', label: 'Dead letters' },
    { section: 'Configuration' },
    { id: 'plans', icon: '◉', label: 'Plans' },
    { id: 'flags', icon: '⚑', label: 'Feature flags' },
    { id: 'staff', icon: '⚙', label: 'Staff users' },
  ];

  function route() {
    var raw = (location.hash || '#/').replace(/^#\/?/, '');
    var p = raw.split('/');
    return { name: p[0] || '', arg: p[1] || null };
  }

  function paint() {
    var r = route();
    var nav = NAV.map(function (i) {
      if (i.section) return '<div class="nav-sep">' + h(i.section) + '</div>';
      return '<a class="nav-item' + (i.id === r.name ? ' active' : '') + '" href="#/' + i.id + '">' +
        '<span class="ico">' + i.icon + '</span>' + h(i.label) + '</a>';
    }).join('');

    root.innerHTML =
      '<div class="shell"><aside class="sidebar">' +
        '<div class="brand"><span class="brand-mark">J</span>Jsyxi Staff</div>' + nav +
      '</aside><div class="main">' +
        '<header class="topbar">' +
          '<span class="badge staff-tag">Staff console</span>' +
          '<div class="spacer"></div>' +
          (me && me.role ? '<span class="badge">' + h(titleCase(me.role)) + '</span>' : '') +
          '<button class="btn sm" id="out">Sign out</button>' +
        '</header><main class="content" id="view"></main>' +
      '</div></div>';

    document.getElementById('out').addEventListener('click', function () {
      api('/admin/auth/logout', { method: 'POST', body: {} })
        .catch(function () {}).then(function () { me = null; paintLogin(); });
    });

    (SCREENS[r.name] || notFound)(r.arg);
  }

  function loading() {
    return '<div class="card"><div class="card-body">' +
      '<div class="skel" style="width:35%"></div>' +
      '<div class="skel" style="width:70%;margin-top:10px"></div></div></div>';
  }
  function errorCard(e) {
    return '<div class="card"><div class="card-body"><div class="banner bad"><div>' +
      '<strong>Could not load.</strong><br>' + h(e && e.message ? e.message : 'Unknown error') +
      '</div></div></div></div>';
  }
  function empty(t, s) {
    return '<div class="empty"><div class="big">' + h(t) + '</div><div>' + h(s || '') + '</div></div>';
  }
  function notFound() {
    document.getElementById('view').innerHTML =
      '<div class="card"><div class="card-body">' + empty('Page not found') + '</div></div>';
  }

  // ─── Screens ──────────────────────────────────────────────────────────

  /** Everything a platform operator wants on one screen: how many sellers, how
   *  many are live, and what is on fire right now. */
  function screenOverview() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Overview</h1></div>' + loading();

    Promise.all([
      api('/admin/merchants').catch(function () { return []; }),
      api('/admin/support/tickets/metrics').catch(function () { return null; }),
      api('/admin/monitors/booking-failures').catch(function () { return null; }),
    ]).then(function (res) {
      var merchants = unwrap(res[0]);
      var tm = res[1] || {};
      var failures = unwrap(res[2]);

      // "Active" is an explicit definition, stated on screen: an installed
      // shop whose subscription is live or trialing. Counting rows without
      // saying what was counted is how dashboards start lying.
      var active = merchants.filter(function (m) {
        var s = String(m.accountState || m.account_state || m.subscriptionState || m.subscription_state || '');
        return s === 'ACTIVE' || s === 'TRIALING';
      }).length;
      var brokenTotal = merchants.reduce(function (n, m) {
        return n + (Number(m.brokenItems || m.broken_items || 0) || 0);
      }, 0);
      var open = (tm.byState && (tm.byState.OPEN || 0)) || 0;
      var waiting = (tm.byState && (tm.byState.WAITING_ON_MERCHANT || 0)) || 0;

      function tile(label, value, sub, href) {
        var inner = '<div class="tile-label">' + h(label) + '</div>' +
          '<div class="tile-value' + (Number(value) > 0 ? ' attn' : ' zero') + '">' + num(value) + '</div>' +
          (sub ? '<div class="tile-sub">' + h(sub) + '</div>' : '');
        return href ? '<a class="tile" href="' + href + '">' + inner + '</a>'
                    : '<div class="tile">' + inner + '</div>';
      }

      view.innerHTML = '<div class="page-head"><h1>Overview</h1></div>' +
        '<div class="stack">' +
          '<div class="tiles">' +
            tile('Merchants', merchants.length, 'connected stores', '#/merchants') +
            tile('Active', active, 'active or trialing', '#/merchants') +
            tile('Open tickets', open, 'awaiting staff', '#/tickets') +
            tile('Waiting on merchant', waiting, 'not our turn', '#/tickets') +
            tile('Setup issues', brokenTotal, 'across all merchants', '#/merchants') +
            tile('Booking failures', failures.length, 'recent', '#/monitors') +
          '</div>' +
          '<div class="card"><div class="card-head"><h2>Support responsiveness</h2></div>' +
            '<div class="card-body"><dl class="kv">' +
              '<dt>Tickets total</dt><dd>' + num(tm.total) + '</dd>' +
              '<dt>Avg first response</dt><dd>' +
                (tm.avgFirstResponseHours === null || tm.avgFirstResponseHours === undefined
                  ? '<span class="muted">—</span>' : tm.avgFirstResponseHours.toFixed(1) + ' h') + '</dd>' +
              '<dt>Avg resolution</dt><dd>' +
                (tm.avgResolutionHours === null || tm.avgResolutionHours === undefined
                  ? '<span class="muted">—</span>' : tm.avgResolutionHours.toFixed(1) + ' h') + '</dd>' +
            '</dl></div></div>' +
        '</div>';
    }).catch(function (e) {
      if (e.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Overview</h1></div>' + errorCard(e);
    });
  }

  /** §9.13 merchant directory — every seller, with the health signals that
   *  decide who needs attention. */
  function screenMerchants() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Merchants</h1></div>' + loading();

    api('/admin/merchants?sort=broken').catch(function () {
      return api('/admin/merchants');
    }).then(function (payload) {
      var rows = unwrap(payload);
      var body = rows.length
        ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Store</th><th>Account</th><th>Plan</th><th class="num">Orders</th>' +
          '<th class="num">Last 7d</th><th class="num">AWBs cycle</th><th>Couriers</th>' +
          '<th class="num">Failed</th><th class="num">Setup</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (m) {
            var domain = m.myshopifyDomain || m.myshopify_domain || m.domain || '—';
            var broken = Number(m.broken_health_count || m.brokenHealthCount || 0);
            var couriers = m.courierCount !== undefined ? m.courierCount : m.courier_count;
            var unhealthy = Number(m.unhealthyCourierCount || m.unhealthy_courier_count || 0);
            var failed = Number(m.failed_booking_count || m.failedBookingCount || 0);
            return '<tr>' +
              '<td><strong>' + h(domain) + '</strong></td>' +
              '<td>' + badge(m.accountState || m.account_state) +
                ' ' + badge(m.subscriptionState || m.subscription_state) + '</td>' +
              '<td>' + h(m.planCode || m.plan_code || '—') + '</td>' +
              '<td class="num">' + num(m.order_count !== undefined ? m.order_count : m.orderCount) + '</td>' +
              '<td class="num">' + num(m.orders_last_7d !== undefined ? m.orders_last_7d : m.ordersLast7d) + '</td>' +
              '<td class="num">' + num(m.awb_used_this_cycle !== undefined ? m.awb_used_this_cycle : m.awbUsedThisCycle) + '</td>' +
              '<td>' + num(couriers) +
                (unhealthy > 0 ? ' <span class="badge bad">' + num(unhealthy) + ' unhealthy</span>' : '') + '</td>' +
              '<td class="num">' + (failed > 0
                ? '<span class="badge bad">' + num(failed) + '</span>' : '<span class="muted">0</span>') + '</td>' +
              '<td class="num">' + (broken > 0
                ? '<span class="badge warn">' + num(broken) + '</span>' : '<span class="muted">0</span>') + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No merchants yet', 'Stores appear here as soon as they install the app.');

      view.innerHTML = '<div class="page-head"><h1>Merchants</h1>' +
        '<span class="muted">Every store that has installed Jsyxi</span></div>' +
        '<div class="card"><div class="card-head"><h2>Directory</h2><div class="spacer"></div>' +
        '<span class="muted" style="font-size:12.5px">' + num(rows.length) + '</span></div>' +
        '<div class="card-body flush">' + body + '</div></div>';
    }).catch(function (e) {
      if (e.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Merchants</h1></div>' + errorCard(e);
    });
  }

  /** §9.18 ticket inbox — what sellers have raised, across all stores. */
  function screenTickets() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Support tickets</h1></div>' + loading();

    Promise.all([
      api('/admin/support/tickets'),
      api('/admin/support/tickets/metrics').catch(function () { return {}; }),
    ]).then(function (res) {
      var rows = unwrap(res[0]);
      var m = res[1] || {};
      var byState = m.byState || {};

      var chips = Object.keys(byState).map(function (k) {
        return '<span class="badge ' + (TONE[k] || '') + '">' + h(titleCase(k)) + ': ' + num(byState[k]) + '</span>';
      }).join(' ');

      var body = rows.length
        ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>#</th><th>Subject</th><th>Store</th><th>Category</th><th>Priority</th>' +
          '<th>State</th><th>Assigned</th><th>Raised</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (t) {
            var assigned = t.assignedAdminId || t.assigned_admin_id;
            return '<tr>' +
              '<td class="mono">' + h(t.number || '—') + '</td>' +
              '<td><a class="row-link" href="#/tickets/' + h(t.ticketId || t.ticket_id) + '">' + h(t.subject || '—') + '</a></td>' +
              '<td class="muted">' + h(t.myshopifyDomain || t.myshopify_domain ||
                String(t.shopId || t.shop_id || '').slice(0, 8)) + '</td>' +
              '<td>' + h(titleCase(t.category)) + '</td>' +
              '<td>' + badge(t.priority) + '</td>' +
              '<td>' + badge(t.state) + '</td>' +
              '<td>' + (assigned ? '<span class="mono muted">' + h(String(assigned).slice(0, 8)) + '</span>'
                                 : '<span class="badge warn">Unassigned</span>') + '</td>' +
              '<td class="muted">' + h(dateTime(t.createdAt || t.created_at)) + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No tickets', 'Tickets raised by merchants appear here.');

      view.innerHTML = '<div class="page-head"><h1>Support tickets</h1>' +
        '<span class="muted">Raised by merchants</span></div>' +
        (chips ? '<div class="row" style="margin-bottom:14px">' + chips + '</div>' : '') +
        '<div class="card"><div class="card-head"><h2>Inbox</h2><div class="spacer"></div>' +
        '<span class="muted" style="font-size:12.5px">' + num(rows.length) + '</span></div>' +
        '<div class="card-body flush">' + body + '</div></div>';
    }).catch(function (e) {
      if (e.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Support tickets</h1></div>' + errorCard(e);
    });
  }

  function simple(title, subtitle, sources, render) {
    return function () {
      var view = document.getElementById('view');
      view.innerHTML = '<div class="page-head"><h1>' + h(title) + '</h1></div>' + loading();
      Promise.all(sources.map(function (s) {
        return api(s).catch(function (e) { return { __err: e }; });
      })).then(function (res) {
        view.innerHTML = '<div class="page-head"><h1>' + h(title) + '</h1>' +
          (subtitle ? '<span class="muted">' + h(subtitle) + '</span>' : '') + '</div>' +
          render(res);
      }).catch(function (e) {
        if (e.message === 'unauthenticated') return;
        view.innerHTML = '<div class="page-head"><h1>' + h(title) + '</h1></div>' + errorCard(e);
      });
    };
  }

  function table(cols, rows, emptyTitle, emptySub) {
    if (!rows.length) return empty(emptyTitle, emptySub);
    return '<div class="table-wrap"><table class="data"><thead><tr>' +
      cols.map(function (c) { return '<th' + (c.num ? ' class="num"' : '') + '>' + h(c.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + cols.map(function (c) {
          return '<td' + (c.num ? ' class="num"' : '') + '>' + c.cell(r) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function card(title, inner, count) {
    return '<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>' + h(title) + '</h2>' +
      '<div class="spacer"></div>' +
      (count !== undefined ? '<span class="muted" style="font-size:12.5px">' + num(count) + '</span>' : '') +
      '</div><div class="card-body flush">' + inner + '</div></div>';
  }

  var screenMonitors = simple('Monitors', 'Platform health across all merchants',
    ['/admin/monitors/booking-failures', '/admin/monitors/courier-api-failures',
     '/admin/monitors/unmapped-statuses'],
    function (res) {
      var bf = unwrap(res[0]), cf = unwrap(res[1]), um = unwrap(res[2]);
      return card('Booking failures', table([
        { label: 'Shop', cell: function (r) { return '<span class="muted">' + h(String(r.shopId || r.shop_id || '').slice(0, 8)) + '</span>'; } },
        { label: 'Courier', cell: function (r) { return h(titleCase(r.courierCode || r.courier_code || '—')); } },
        { label: 'Reason', cell: function (r) { return h(r.reason || r.failureReason || r.failure_reason || '—'); } },
        { label: 'When', cell: function (r) { return '<span class="muted">' + h(dateTime(r.createdAt || r.created_at)) + '</span>'; } },
      ], bf, 'No booking failures', 'Nothing has failed recently.'), bf.length) +
      card('Courier API failures', table([
        { label: 'Courier', cell: function (r) { return h(titleCase(r.courierCode || r.courier_code || '—')); } },
        { label: 'Operation', cell: function (r) { return h(titleCase(r.operation || r.method || '—')); } },
        { label: 'Count', num: true, cell: function (r) { return num(r.count || r.failures); } },
      ], cf, 'No courier API failures'), cf.length) +
      card('Unmapped courier statuses', table([
        { label: 'Courier', cell: function (r) { return h(titleCase(r.courierCode || r.courier_code || '—')); } },
        { label: 'Raw status', cell: function (r) { return '<span class="mono">' + h(r.rawStatus || r.raw_status || '—') + '</span>'; } },
        { label: 'Seen', num: true, cell: function (r) { return num(r.count || r.occurrences); } },
      ], um, 'Every courier status is mapped',
         'An unmapped status means the tracking reducer saw something it did not understand.'), um.length);
    });

  var screenDlq = simple('Dead letters', 'Jobs that exhausted their retries',
    ['/admin/dlq/items'],
    function (res) {
      var rows = unwrap(res[0]);
      return card('Items', table([
        { label: 'Queue', cell: function (r) { return h(r.queue || r.queueName || '—'); } },
        { label: 'Shop', cell: function (r) { return '<span class="muted">' + h(String(r.shopId || r.shop_id || '').slice(0, 8)) + '</span>'; } },
        { label: 'Error', cell: function (r) { return h(r.error || r.lastError || r.last_error || '—'); } },
        { label: 'Failed', cell: function (r) { return '<span class="muted">' + h(dateTime(r.createdAt || r.created_at)) + '</span>'; } },
      ], rows, 'No dead letters', 'Every job has completed or is still retrying.'), rows.length);
    });

  var screenPlans = simple('Plans', 'Subscription plans offered to merchants',
    ['/admin/plans'],
    function (res) {
      var rows = unwrap(res[0]);
      return card('Plans', table([
        { label: 'Code', cell: function (r) { return '<strong>' + h(r.code) + '</strong>'; } },
        { label: 'Name', cell: function (r) { return h(r.name || '—'); } },
        { label: 'Price', num: true, cell: function (r) { return money(r.price || r.monthlyPrice || r.monthly_price); } },
        { label: 'AWBs included', num: true, cell: function (r) {
          return num(r.includedAwbs !== undefined ? r.includedAwbs : r.included_awbs); } },
        { label: 'Active', cell: function (r) {
          var a = r.isActive !== undefined ? r.isActive : r.is_active;
          return a ? '<span class="badge ok">Active</span>' : '<span class="badge">Retired</span>'; } },
      ], rows, 'No plans configured'), rows.length);
    });

  var screenFlags = simple('Feature flags', 'Platform-wide toggles',
    ['/admin/feature-flags'],
    function (res) {
      var p = res[0] || {};
      var rows = Array.isArray(p) ? p : Object.keys(p).map(function (k) {
        return { key: k, enabled: p[k] };
      });
      return card('Flags', table([
        { label: 'Flag', cell: function (r) { return '<span class="mono">' + h(r.key || r.flag) + '</span>'; } },
        { label: 'State', cell: function (r) {
          var on = r.enabled !== undefined ? r.enabled : r.value;
          return on ? '<span class="badge ok">On</span>' : '<span class="badge">Off</span>'; } },
      ], rows, 'No feature flags'), rows.length);
    });

  var screenStaff = simple('Staff users', 'Who can access this console',
    ['/admin/auth/users'],
    function (res) {
      var rows = unwrap(res[0]);
      return card('Staff', table([
        { label: 'Email', cell: function (r) { return '<strong>' + h(r.email || '—') + '</strong>'; } },
        { label: 'Role', cell: function (r) { return badge(r.role); } },
        { label: 'TOTP', cell: function (r) {
          var e = r.totpEnrolled !== undefined ? r.totpEnrolled : r.totp_enrolled;
          return e ? '<span class="badge ok">Enrolled</span>'
                   : '<span class="badge warn">Not enrolled</span>'; } },
        { label: 'State', cell: function (r) {
          var d = r.deactivatedAt || r.deactivated_at;
          return d ? '<span class="badge bad">Deactivated</span>' : '<span class="badge ok">Active</span>'; } },
      ], rows, 'No staff users'), rows.length);
    });

  /**
   * Staff ticket view: the merchant's conversation plus the three actions
   * §3.16 defines — assign, reply, transition. Version is echoed back on
   * assign/transition because the ticket row is optimistically locked; acting
   * on a stale version must fail rather than silently overwrite a colleague.
   */
  function screenTicket(ticketId) {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Ticket</h1></div>' + loading();

    Promise.all([
      api('/admin/support/tickets'),
      api('/admin/support/tickets/' + encodeURIComponent(ticketId) + '/context')
        .catch(function (e) { return { __err: e }; }),
      api('/admin/auth/users').catch(function () { return []; }),
    ]).then(function (res) {
      var t = unwrap(res[0]).filter(function (x) {
        return (x.ticketId || x.ticket_id) === ticketId;
      })[0];
      if (!t) {
        view.innerHTML = '<div class="page-head"><a class="btn sm" href="#/tickets">← Tickets</a>' +
          '<h1>Ticket</h1></div><div class="card"><div class="card-body">' +
          empty('Ticket not found') + '</div></div>';
        return;
      }
      var ctx = res[1] || {};
      var staff = unwrap(res[2]);
      var messages = ctx.messages || ctx.thread || [];

      var bubbles = messages.length ? messages.map(function (m) {
        var fromStaff = (m.authorKind || m.author_kind) === 'ADMIN';
        return '<div style="display:flex;justify-content:' + (fromStaff ? 'flex-end' : 'flex-start') +
          ';margin-bottom:10px"><div style="max-width:min(72%,560px);padding:10px 13px;' +
          'border-radius:var(--r-md);background:' +
          (fromStaff ? '#4c3a6b;color:#fff' : 'var(--surface-sunk)') + '">' +
          '<div style="font-size:11.5px;opacity:.75;margin-bottom:3px">' +
            h(fromStaff ? 'Staff' : 'Merchant') + ' · ' + h(dateTime(m.createdAt || m.created_at)) + '</div>' +
          '<div style="white-space:pre-wrap">' + h(m.body || '') + '</div></div></div>';
      }).join('') : (ctx.__err
        ? '<div class="banner warn"><div>Conversation unavailable: ' + h(ctx.__err.message) + '</div></div>'
        : empty('No messages'));

      var version = t.version || 1;
      var states = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

      view.innerHTML =
        '<div class="page-head"><a class="btn sm" href="#/tickets">← Tickets</a>' +
          '<h1>' + h(t.subject || 'Ticket') + '</h1>' + badge(t.state) + badge(t.priority) + '</div>' +
        '<div class="stack">' +
          '<div class="card"><div class="card-body">' +
            '<dl class="kv">' +
              '<dt>Ticket</dt><dd class="mono">' + h(t.number || '—') + '</dd>' +
              '<dt>Category</dt><dd>' + h(titleCase(t.category)) + '</dd>' +
              '<dt>Store</dt><dd class="mono">' + h(String(t.shopId || t.shop_id || '').slice(0, 8)) + '</dd>' +
              '<dt>Raised</dt><dd>' + h(dateTime(t.createdAt || t.created_at)) + '</dd>' +
            '</dl>' +
            '<div class="row" style="margin-top:12px">' +
              '<select class="input" id="assignee">' +
                '<option value="">Assign to…</option>' +
                staff.map(function (u) {
                  var id = u.adminId || u.admin_id;
                  return '<option value="' + h(id) + '"' +
                    ((t.assignedAdminId || t.assigned_admin_id) === id ? ' selected' : '') + '>' +
                    h(u.email || id) + '</option>';
                }).join('') +
              '</select>' +
              '<button class="btn sm" id="doassign">Assign</button>' +
              '<div class="spacer" style="flex:1"></div>' +
              states.filter(function (s) { return s !== t.state; }).map(function (s) {
                return '<button class="btn sm" data-to="' + h(s) + '">' + h(titleCase(s)) + '</button>';
              }).join(' ') +
            '</div>' +
          '</div></div>' +
          '<div class="card"><div class="card-head"><h2>Conversation</h2></div>' +
            '<div class="card-body">' + bubbles + '</div>' +
            '<div class="card-body" style="border-top:1px solid var(--border)">' +
              '<textarea class="input" id="reply" rows="3" style="width:100%;resize:vertical" ' +
                'placeholder="Reply to the merchant…"></textarea>' +
              '<div class="row" style="margin-top:8px"><div class="spacer" style="flex:1"></div>' +
              '<button class="btn primary" id="sendreply">Send reply</button></div>' +
            '</div></div>' +
        '</div>';

      function fail(e) {
        if (e.message === 'unauthenticated') return;
        var b = e.body || {};
        toast(String(b.message || e.message), true);
      }

      document.getElementById('doassign').addEventListener('click', function () {
        var v = document.getElementById('assignee').value;
        if (!v) { toast('Pick a staff member first', true); return; }
        api('/admin/support/tickets/' + encodeURIComponent(ticketId) + '/assign',
          { method: 'POST', body: { assignedAdminId: v, version: version } })
          .then(function () { toast('Assigned'); screenTicket(ticketId); }).catch(fail);
      });

      Array.prototype.forEach.call(document.querySelectorAll('[data-to]'), function (b) {
        b.addEventListener('click', function () {
          api('/admin/support/tickets/' + encodeURIComponent(ticketId) + '/transition',
            { method: 'POST', body: { to: b.getAttribute('data-to'), version: version } })
            .then(function () { toast('Moved to ' + titleCase(b.getAttribute('data-to'))); screenTicket(ticketId); })
            .catch(fail);
        });
      });

      document.getElementById('sendreply').addEventListener('click', function () {
        var ta = document.getElementById('reply');
        var text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        var btn = document.getElementById('sendreply');
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Sending';
        api('/admin/support/tickets/' + encodeURIComponent(ticketId) + '/messages',
          { method: 'POST', body: { body: text } })
          .then(function () { toast('Reply sent'); screenTicket(ticketId); })
          .catch(function (e) { btn.disabled = false; btn.textContent = 'Send reply'; fail(e); });
      });
    }).catch(function (e) {
      if (e.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Ticket</h1></div>' + errorCard(e);
    });
  }

  /**
   * §9.19 announcements — the push to merchants. Type decides reach:
   * WARNING emails every member on publish (A2-09); INFO and UPDATE are in-app
   * only. Audience decides who: everyone, a plan, or named shops.
   */
  function screenAnnouncements() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Announcements</h1></div>' + loading();

    Promise.all([
      api('/admin/support/announcements'),
      api('/admin/merchants').catch(function () { return []; }),
    ]).then(function (res) {
      var rows = unwrap(res[0]);
      var merchants = unwrap(res[1]);

      var body = rows.length
        ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Title</th><th>Type</th><th>Audience</th><th>State</th><th>Published</th><th></th>' +
          '</tr></thead><tbody>' +
          rows.map(function (a) {
            var id = a.announcementId || a.announcement_id;
            var published = a.publishedAt || a.published_at;
            var expired = a.expiresAt || a.expires_at;
            var state = expired && new Date(expired) < new Date() ? 'EXPIRED'
                      : published ? 'PUBLISHED' : 'DRAFT';
            return '<tr>' +
              '<td>' + (a.image_url
                ? '<img src="' + h(a.image_url) + '" alt="" style="width:28px;height:28px;' +
                  'object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:8px" />'
                : '') + '<strong>' + h(a.title || '—') + '</strong></td>' +
              '<td>' + badge(a.type) + '</td>' +
              '<td>' + h(titleCase(a.audienceKind || a.audience_kind || 'ALL')) + '</td>' +
              '<td>' + badge(state) + '</td>' +
              '<td class="muted">' + h(published ? dateTime(published) : '—') + '</td>' +
              '<td style="text-align:right">' +
                (state === 'DRAFT'
                  ? '<button class="btn sm primary" data-pub="' + h(id) + '">Publish</button>'
                  : state === 'PUBLISHED'
                    ? '<button class="btn sm" data-exp="' + h(id) + '">Expire</button>' : '') +
              '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No announcements', 'Compose one to notify merchants.');

      view.innerHTML = '<div class="page-head"><h1>Announcements</h1>' +
        '<span class="muted">Notify merchants in-app, or by email for warnings</span>' +
        '<div class="spacer"></div><button class="btn primary" id="compose">New announcement</button></div>' +
        '<div class="card"><div class="card-head"><h2>Sent</h2><div class="spacer"></div>' +
        '<span class="muted" style="font-size:12.5px">' + num(rows.length) + '</span></div>' +
        '<div class="card-body flush">' + body + '</div></div>';

      document.getElementById('compose').addEventListener('click', function () {
        openCompose(merchants, screenAnnouncements);
      });

      function act(sel, path, label) {
        Array.prototype.forEach.call(document.querySelectorAll('[' + sel + ']'), function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute(sel);
            b.disabled = true;
            api('/admin/support/announcements/' + encodeURIComponent(id) + '/' + path,
              { method: 'POST', body: {} })
              .then(function () { toast(label); screenAnnouncements(); })
              .catch(function (e) {
                b.disabled = false;
                if (e.message === 'unauthenticated') return;
                toast(String((e.body && e.body.message) || e.message), true);
              });
          });
        });
      }
      act('data-pub', 'publish', 'Announcement published');
      act('data-exp', 'expire', 'Announcement expired');
    }).catch(function (e) {
      if (e.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Announcements</h1></div>' + errorCard(e);
    });
  }

  function openCompose(merchants, onDone) {
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-head"><h2>New announcement</h2><div class="spacer"></div>' +
          '<button class="x" data-close>×</button></div>' +
        '<div class="modal-body">' +
          '<form id="af" style="display:grid;gap:12px">' +
            '<div><label for="atype">Type</label>' +
              '<select class="input" id="atype" style="width:100%">' +
                '<option value="INFO">Info — in-app only</option>' +
                '<option value="UPDATE">Update — in-app only</option>' +
                '<option value="WARNING">Warning — in-app AND emails every member</option>' +
              '</select></div>' +
            '<div><label for="aaud">Audience</label>' +
              '<select class="input" id="aaud" style="width:100%">' +
                '<option value="ALL">All merchants</option>' +
                '<option value="BY_PLAN">Merchants on a plan</option>' +
                '<option value="SPECIFIC_SHOPS">Specific merchants</option>' +
              '</select></div>' +
            '<div id="audextra"></div>' +
            '<div><label for="atitle">Title</label>' +
              '<input class="input" id="atitle" maxlength="500" required style="width:100%" /></div>' +
            '<div><label for="abody">Message</label>' +
              '<textarea class="input" id="abody" rows="5" required style="width:100%;resize:vertical"></textarea></div>' +
            '<div><label for="aimg">Image URL <span class="muted">(optional)</span></label>' +
              '<input class="input" id="aimg" type="url" style="width:100%" ' +
                'placeholder="https://cdn.example.com/notice.png" />' +
              '<div class="muted" style="font-size:12px;margin-top:3px">' +
                'Must be a public https link. Merchants see it beside the message.</div>' +
              '<div id="aimgprev"></div></div>' +
          '</form>' +
          /* Publishing is the moment it reaches merchants, so composing and
             sending are separate actions — a typo in a WARNING would email
             every member of every store. */
          '<p class="note">Composing creates a draft. It reaches merchants only when you publish it.</p>' +
        '</div>' +
        '<div class="modal-foot"><span id="amsg" class="muted"></span><div class="spacer"></div>' +
          '<button class="btn" data-close>Cancel</button>' +
          '<button class="btn primary" id="asave">Create draft</button></div>' +
      '</div>';
    document.body.appendChild(back);
    back.addEventListener('click', function (e) {
      if (e.target === back || e.target.hasAttribute('data-close')) back.remove();
    });

    var aud = back.querySelector('#aaud');
    var extra = back.querySelector('#audextra');
    aud.addEventListener('change', function () {
      if (aud.value === 'BY_PLAN') {
        extra.innerHTML = '<label for="aplan">Plan code</label>' +
          '<input class="input" id="aplan" style="width:100%" placeholder="e.g. TRIAL" />';
      } else if (aud.value === 'SPECIFIC_SHOPS') {
        extra.innerHTML = '<label for="ashops">Merchants</label>' +
          '<select class="input" id="ashops" multiple size="6" style="width:100%">' +
          merchants.map(function (m) {
            var id = m.shopId || m.shop_id;
            return '<option value="' + h(id) + '">' +
              h(m.myshopifyDomain || m.myshopify_domain || id) + '</option>';
          }).join('') + '</select>' +
          '<span class="note">Ctrl/Cmd-click to select more than one.</span>';
      } else {
        extra.innerHTML = '';
      }
    });

    /* Preview before sending. A broken or private image link is invisible to
       the composer but visible to every merchant, so it is worth catching
       here. Built with DOM calls rather than an inline onerror attribute —
       nesting quotes inside an HTML attribute inside a JS string is how you
       ship a syntax error. */
    var imgInput = back.querySelector('#aimg');
    imgInput.addEventListener('change', function () {
      var prev = back.querySelector('#aimgprev');
      prev.textContent = '';
      var v = imgInput.value.trim();
      if (!v) return;
      var img = document.createElement('img');
      img.alt = '';
      img.style.cssText =
        'max-width:160px;margin-top:8px;border-radius:var(--r-sm);border:1px solid var(--border)';
      img.onerror = function () {
        var note = document.createElement('div');
        note.className = 'muted';
        note.style.cssText = 'font-size:12px;margin-top:6px';
        note.textContent = 'That image could not be loaded — check the link is public.';
        img.replaceWith(note);
      };
      img.src = v;
      prev.appendChild(img);
    });

    back.querySelector('#asave').addEventListener('click', function () {
      var form = back.querySelector('#af');
      if (!form.reportValidity()) return;
      var btn = back.querySelector('#asave');
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Creating';

      var body = {
        type: back.querySelector('#atype').value,
        audienceKind: aud.value,
        title: back.querySelector('#atitle').value.trim(),
        body: back.querySelector('#abody').value.trim(),
      };
      // Only send when filled — an empty string fails @IsUrl.
      var img = back.querySelector('#aimg').value.trim();
      if (img) body.imageUrl = img;
      // §3.29: audienceRef must be null for ALL, and shaped per kind otherwise.
      if (aud.value === 'BY_PLAN') {
        body.audienceRef = { planCode: (back.querySelector('#aplan') || {}).value || '' };
      } else if (aud.value === 'SPECIFIC_SHOPS') {
        var sel = back.querySelector('#ashops');
        body.audienceRef = {
          shopIds: sel ? Array.prototype.slice.call(sel.selectedOptions).map(function (o) { return o.value; }) : [],
        };
      }

      api('/admin/support/announcements', { method: 'POST', body: body })
        .then(function () { back.remove(); toast('Draft created — publish it to send'); if (onDone) onDone(); })
        .catch(function (e) {
          if (e.message === 'unauthenticated') return;
          btn.disabled = false; btn.textContent = 'Create draft';
          var b = e.body || {};
          var msg = Array.isArray(b.message) ? b.message.join(' · ') : (b.message || e.message);
          back.querySelector('#amsg').innerHTML =
            '<span style="color:var(--bad-fg)">' + h(String(msg)) + '</span>';
        });
    });
  }

  var SCREENS = {
    '': screenOverview,
    'merchants': screenMerchants,
    'tickets': function (arg) { return arg ? screenTicket(arg) : screenTickets(); },
    'announcements': screenAnnouncements,
    'monitors': screenMonitors,
    'dlq': screenDlq,
    'plans': screenPlans,
    'flags': screenFlags,
    'staff': screenStaff,
  };

  window.addEventListener('hashchange', function () { if (me) paint(); });

  // Probe an authenticated endpoint to decide login vs console, so a stale
  // cookie lands on the login form rather than a console full of 401s.
  fetch('/admin/merchants', { credentials: 'same-origin' }).then(function (r) {
    if (r.status === 401 || r.status === 403) { paintLogin(); return; }
    me = me || {};
    paint();
  }).catch(function () { paintLogin(); });
})();
