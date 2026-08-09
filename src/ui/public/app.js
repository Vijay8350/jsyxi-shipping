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

  function titleCase(s) {
    return String(s || '').replace(/_/g, ' ').toLowerCase()
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
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
    { section: 'Configure' },
    { id: 'couriers', icon: '◈', label: 'Couriers' },
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
            '<button class="btn sm" id="logout">Sign out</button>' +
          '</header>' +
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
  var TONE = {
    DELIVERED: 'ok', CONFIRMED: 'ok', ACTIVE: 'ok', CONNECTED: 'ok', READY: 'ok',
    IN_TRANSIT: 'info', OUT_FOR_DELIVERY: 'info', QUEUED: 'info', IMPORTED: 'info',
    PICKUP_PENDING: 'warn', NEEDS_MANUAL_ASSIGNMENT: 'warn', NDR: 'warn',
    UNASSIGNED: 'warn', ISSUE_PENDING: 'warn', DEGRADED: 'warn',
    FAILED: 'bad', CANCELLED: 'bad', RTO: 'bad', RTO_DELIVERED: 'bad',
    DISCONNECTED: 'bad', LOST: 'bad',
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
          '<div class="tile-value' + (v > 0 ? ' attn' : '') + '">' + num(v) + '</div>';
        return meta.to
          ? '<a class="tile" href="' + meta.to + '">' + inner + '</a>'
          : '<div class="tile">' + inner + '</div>';
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

      var perf = (d.servicePerformance || []).slice(0, 8).map(function (r) {
        return '<tr>' +
          '<td>' + h(r.serviceName || r.courierCode || 'Unassigned') + '</td>' +
          '<td class="num">' + num(r.booked) + '</td>' +
          '<td class="num">' + num(r.delivered) + '</td>' +
          '<td class="num">' + (r.deliveryRate === null || r.deliveryRate === undefined
            ? '—' : (r.deliveryRate * 100).toFixed(1) + '%') + '</td>' +
          '<td class="num">' + (r.rtoRate === null || r.rtoRate === undefined
            ? '—' : (r.rtoRate * 100).toFixed(1) + '%') + '</td>' +
          '<td class="num">' + (r.avgTatHours === null || r.avgTatHours === undefined
            ? '—' : r.avgTatHours.toFixed(1) + ' h') + '</td>' +
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
                '<th>Service</th><th class="num">Booked</th><th class="num">Delivered</th>' +
                '<th class="num">Delivery rate</th><th class="num">RTO rate</th><th class="num">Avg TAT</th>' +
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
    states: ['IMPORTED', 'READY', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'EXCLUDED'],
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
    states: ['DRAFT', 'QUEUED', 'CONFIRMED', 'FAILED', 'CANCELLED', 'NEEDS_MANUAL_ASSIGNMENT'],
    emptyTitle: 'No shipments here',
    emptySub: 'A shipment appears once an order is ready to book.',
    columns: [
      { label: 'AWB' }, { label: 'Order' }, { label: 'Courier' }, { label: 'Booking' },
      { label: 'Movement' }, { label: 'Custody' }, { label: 'COD', num: true }, { label: 'Booked' },
    ],
    row: function (s) {
      return '<tr>' +
        '<td class="mono">' + (s.awb ? h(s.awb) : '<span class="muted">not booked</span>') +
          testMarker(s.isTest) + '</td>' +
        '<td><a class="row-link" href="#/orders/' + h(s.orderId) + '">' +
          h(s.orderNumber || s.orderId.slice(0, 8)) + '</a></td>' +
        '<td>' + (s.courierCode ? h(titleCase(s.courierCode)) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + stateBadge(s.bookingState) + '</td>' +
        '<td>' + stateBadge(s.movementState) + '</td>' +
        '<td>' + stateBadge(s.custodyState) + '</td>' +
        '<td class="num money">' + (Number(s.collectible) > 0 ? money(s.collectible) : '<span class="muted">—</span>') + '</td>' +
        '<td class="muted">' + h(s.bookedAt ? dateTime(s.bookedAt) : '—') + '</td>' +
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

  function screenCouriers() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="page-head"><h1>Couriers</h1></div>' + loading();

    Promise.all([
      api('/couriers').catch(function () { return []; }),
      api('/courier-accounts').catch(function () { return []; }),
    ]).then(function (res) {
      var master = res[0] || [];
      var accounts = res[1] || [];
      var byCourier = {};
      (Array.isArray(accounts) ? accounts : accounts.items || []).forEach(function (a) {
        var key = a.courierCode || a.courier_code || a.courierId;
        (byCourier[key] = byCourier[key] || []).push(a);
      });

      var list = (Array.isArray(master) ? master : master.items || []);
      var rows = list.map(function (c) {
        var code = c.code || c.courierCode;
        var accts = byCourier[code] || [];
        var connected = accts.length > 0;
        var health = accts[0] && (accts[0].healthState || accts[0].health_state);
        return '<tr>' +
          '<td><strong>' + h(c.name || titleCase(code)) + '</strong></td>' +
          '<td class="mono muted">' + h(code) + '</td>' +
          '<td>' + (connected
            ? stateBadge(health || 'CONNECTED')
            : '<span class="badge">Not connected</span>') + '</td>' +
          '<td class="num">' + num(accts.length) + '</td>' +
          '</tr>';
      }).join('');

      view.innerHTML =
        '<div class="page-head"><h1>Couriers</h1></div>' +
        '<div class="card">' +
          '<div class="card-head"><h2>Launch couriers</h2><div class="spacer"></div>' +
            '<span class="muted" style="font-size:12.5px">Bring your own courier account</span></div>' +
          '<div class="card-body flush">' +
          (rows ? '<div class="table-wrap"><table class="data"><thead><tr>' +
            '<th>Courier</th><th>Code</th><th>Status</th><th class="num">Accounts</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>'
                : empty('No couriers seeded', 'Run the courier seed to populate the master list.')) +
          '</div></div>';
    }).catch(function (err) {
      if (err.message === 'unauthenticated') return;
      view.innerHTML = '<div class="page-head"><h1>Couriers</h1></div>' + errorCard(err);
    });
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
        return '<tr><td class="mono">' + h(m.memberId || m.member_id || '—') + '</td>' +
          '<td>' + stateBadge(m.role) + '</td>' +
          '<td>' + h(titleCase(m.authSource || m.auth_source || '')) + '</td>' +
          '<td class="muted">' + h(m.lastActiveAt || m.last_active_at
            ? dateTime(m.lastActiveAt || m.last_active_at) : '—') + '</td></tr>';
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

  // ─── Router ───────────────────────────────────────────────────────────
  var ROUTES = {
    '': screenDashboard,
    'orders': function (arg) { return arg ? screenOrderDetail(arg) : screenOrders(); },
    'shipments': screenShipments,
    'couriers': screenCouriers,
    'settings': screenSettings,
  };

  function paint() {
    var route = currentRoute();
    root.innerHTML = shell(route);

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
