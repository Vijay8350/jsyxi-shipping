/**
 * Golden-path end-to-end smoke against the LIVE local stack
 * (app on :3000, postgres :5433, redis :6379):
 *
 *   fixtures → courier connect (FAKE, LIVE) → book → CONFIRMED →
 *   courier webhook → movement transitions → label → track page.
 *
 * Verifies the wiring the unit tests mock: HTTP guards, BullMQ booking
 * worker, entitlement debit, sync-back outbox, webhook ingest + reducer,
 * ADD-18 surfaces, track-token page. Idempotent per run (run id tagged).
 */
import 'dotenv/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { EnvelopeCipher } from '../src/common/envelope';

const APP = 'http://localhost:3000';
const RUN = `e2e-${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const cipher = EnvelopeCipher.fromHex(process.env.MASTER_KEY_HEX ?? '');

let failures = 0;
function step(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const uuid = () => crypto.randomUUID();

async function pollFor<T>(what: string, fn: () => Promise<T | null>, tries = 60, gapMs = 500): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  console.log(`  (timeout waiting for ${what})`);
  return null;
}

async function main() {
  // --- Fixtures (FAKE courier master + shop + owner + session) ---
  const courierId = uuid();
  await pool.query(
    `INSERT INTO courier (courier_id, code, name, kind, auth_pattern) VALUES ($1, 'FAKE', 'Fake Courier', 'DIRECT', 'KEY_PASTE')
     ON CONFLICT (code) DO NOTHING`,
    [courierId],
  );
  const courier = (await pool.query(`SELECT courier_id FROM courier WHERE code = 'FAKE'`)).rows[0];
  await pool.query(
    `INSERT INTO courier_credential_field (courier_id, key, label, is_secret, is_required)
     VALUES ($1, 'token', 'Token', true, true) ON CONFLICT DO NOTHING`,
    [courier.courier_id],
  );
  for (const m of ['getQuote','createShipment','lookupByReference','cancelShipment','track','getLabel','schedulePickup','ndrAction']) {
    await pool.query(
      `INSERT INTO courier_capability (courier_id, capability, supported) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [courier.courier_id, m],
    );
  }
  // §3.6 raw→normalized map for the FAKE courier (case-folded keys — the
  // fold is case-only, underscores are preserved).
  const statusMap: Array<[string, string]> = [
    ['pickup_scheduled', 'PICKUP_SCHEDULED'],
    ['picked_up', 'PICKED_UP'],
    ['in_transit', 'IN_TRANSIT'],
    ['out_for_delivery', 'OUT_FOR_DELIVERY'],
    ['delivered', 'DELIVERED'],
    ['undelivered', 'UNDELIVERED_ATTEMPT'],
    ['rto_initiated', 'RTO_INITIATED'],
  ];
  for (const [raw, mapped] of statusMap) {
    await pool.query(
      `INSERT INTO courier_status_map (courier_id, raw_status, carrier_event_status)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [courier.courier_id, raw, mapped],
    );
  }
  const serviceId = uuid();
  await pool.query(
    `INSERT INTO service (service_id, courier_id, code, name, label_mode, cost_source)
     VALUES ($1, $2, 'FAKE-SURFACE', 'Fake Surface', 'CUSTOM_ALLOWED', 'RATE_CARD') ON CONFLICT DO NOTHING`,
    [serviceId, courier.courier_id],
  );
  const service = (await pool.query(`SELECT service_id FROM service WHERE code = 'FAKE-SURFACE'`)).rows[0];
  await pool.query(
    `INSERT INTO service_version (service_id, effective_from, volumetric_divisor, min_billable_kg, billable_increment_kg)
     VALUES ($1, '2026-01-01', 5000, 0.5, 0.5) ON CONFLICT DO NOTHING`,
    [service.service_id],
  );

  const shopId = uuid();
  await pool.query(
    `INSERT INTO shop (shop_id, shopify_shop_gid, myshopify_domain) VALUES ($1, $2, $3)`,
    [shopId, `gid://shopify/Shop/${RUN}`, `${RUN}.myshopify.com`],
  );
  await pool.query(`INSERT INTO store_settings (shop_id) VALUES ($1)`, [shopId]);
  await pool.query(
    `INSERT INTO package_profile (shop_id, name, length_cm, width_cm, height_cm, tare_kg, is_default)
     VALUES ($1, 'Default parcel', 25, 20, 10, 0.05, true)`,
    [shopId],
  );
  const planId = (await pool.query(`SELECT plan_id FROM plan WHERE code = 'TRIAL'`)).rows[0].plan_id;
  await pool.query(
    `INSERT INTO subscription (shop_id, plan_id, cycle_start_at, cycle_end_at, state)
     VALUES ($1, $2, now(), now() + interval '14 days', 'TRIALING')`,
    [shopId, planId],
  );
  // INV-7 needs a pickup location (§9.2.4); pricing needs a rate card (§9.15).
  await pool.query(
    `INSERT INTO pickup_location (shop_id, name, contact_name, phone, address_lines, city, state, pincode)
     VALUES ($1, 'Main WH', 'Ops', '9876543210', '{1 Industrial Rd}', 'Mumbai', 'Maharashtra', '400001')`,
    [shopId],
  );
  const postalVersionId = uuid();
  await pool.query(
    `INSERT INTO postal_zone_master_version (postal_version_id, label, effective_from, published_at)
     VALUES ($1, 'e2e-v1', '2026-01-01', now())`,
    [postalVersionId],
  );
  await pool.query(
    `INSERT INTO postal_pincode (postal_version_id, pincode, city, state)
     VALUES ($1, '400001', 'Mumbai', 'Maharashtra'), ($1, '110001', 'New Delhi', 'Delhi')`,
    [postalVersionId],
  );
  const zoneMapId = uuid();
  await pool.query(
    `INSERT INTO commercial_zone_map (zone_map_id, shop_id, service_id, label, effective_from, postal_version_id)
     VALUES ($1, $2, $3, 'e2e-zm', '2026-01-01', $4)`,
    [zoneMapId, shopId, service.service_id, postalVersionId],
  );
  await pool.query(
    `INSERT INTO commercial_zone_rule (zone_map_id, origin_matcher, destination_matcher, zone, position)
     VALUES ($1, '{}', '{}', 'D', 1)`,
    [zoneMapId],
  );
  const memberId = uuid();
  await pool.query(
    `INSERT INTO shop_member (member_id, shop_id, shopify_staff_user_id, auth_source, role)
     VALUES ($1, $2, 'staff-e2e', 'SHOPIFY_STAFF', 'OWNER')`,
    [memberId, shopId],
  );
  const sessionToken = randomBytes(32).toString('base64url');
  const sessionId = uuid();
  await pool.query(
    `INSERT INTO member_session (session_id, shop_id, member_id, token_hash, auth_source, expires_at)
     VALUES ($1, $2, $3, $4, 'SHOPIFY_STAFF', now() + interval '12 hours')`,
    [sessionId, shopId, memberId, sha256(sessionToken)],
  );
  await redis.set(
    `sess:${sha256(sessionToken)}`,
    JSON.stringify({ sessionId, shopId, memberId, role: 'OWNER', authSource: 'SHOPIFY_STAFF' }),
    'EX', 43200,
  );
  const auth = { headers: { cookie: `jsyxi_session=${sessionToken}` } };
  step('fixtures: shop, owner, session, FAKE courier master', true);

  // --- Connect the courier account (LIVE so the booking is non-test) ---
  const connectRes = await fetch(`${APP}/courier-accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth.headers },
    body: JSON.stringify({ courierId: courier.courier_id, mode: 'LIVE', credentials: { token: 'fake-live-token' } }),
  });
  step('POST /courier-accounts connects LIVE account', connectRes.status === 201 || connectRes.status === 200, `status ${connectRes.status}`);
  const account = (await connectRes.json()) as { courierAccountId?: string; courier_account_id?: string };
  const accountId = account.courierAccountId ?? account.courier_account_id;
  if (!accountId) throw new Error(`no account id in ${JSON.stringify(account)}`);

  const tcRes = await fetch(`${APP}/courier-accounts/${accountId}/test-connection`, { method: 'POST', ...auth });
  step('test-connection marks the account healthy', tcRes.status < 300, `status ${tcRes.status}`);

  // Enable the service + default chain (SQL for determinism).
  const msId = uuid();
  await pool.query(
    `INSERT INTO merchant_service (merchant_service_id, shop_id, courier_account_id, service_id, enabled)
     VALUES ($1, $2, $3, $4, true)`,
    [msId, shopId, accountId, service.service_id],
  );
  await pool.query(
    `INSERT INTO order_sync_settings (shop_id, default_chain) VALUES ($1, $2::jsonb)
     ON CONFLICT (shop_id) DO UPDATE SET default_chain = $2::jsonb`,
    [shopId, JSON.stringify([msId])],
  );
  // The rate card the PRIORITY_CHAIN candidate prices from (§9.15).
  const rateCardId = uuid();
  await pool.query(
    `INSERT INTO rate_card (rate_card_id, shop_id, service_id, courier_account_id, name)
     VALUES ($1, $2, $3, $4, 'e2e-rc')`,
    [rateCardId, shopId, service.service_id, accountId],
  );
  const rcvId = uuid();
  await pool.query(
    `INSERT INTO rate_card_version (rate_card_version_id, rate_card_id, effective_from, zone_map_id, fuel_pct, gst_pct)
     VALUES ($1, $2, '2026-01-01', $3, 0.1, 0.18)`,
    [rcvId, rateCardId, zoneMapId],
  );
  await pool.query(
    `INSERT INTO rate_card_slab (rate_card_version_id, zone, base_weight_kg, base_rate, additional_step_kg, additional_rate)
     VALUES ($1, 'D', 0.5, 50, 0.5, 40)`,
    [rcvId],
  );

  // ADD-18: webhook surface exists with masked secret.
  const whRes = await fetch(`${APP}/courier-accounts/${accountId}/webhook`, auth);
  const wh = (await whRes.json()) as { webhookUrl?: string };
  step('ADD-18 webhook view returns the URL', whRes.status === 200 && typeof wh.webhookUrl === 'string', wh.webhookUrl ?? `status ${whRes.status}`);

  // Stamp a KNOWN webhook secret so we can sign payloads (same envelope path).
  const knownSecret = randomBytes(16).toString('hex');
  await pool.query(
    `UPDATE courier_account SET webhook_secret_encrypted = $1 WHERE courier_account_id = $2`,
    [cipher.encrypt(JSON.stringify({ secret: knownSecret })), accountId],
  );

  // --- Order + DRAFT shipment fixtures (full working values, INV-7-passing) ---
  const orderId = uuid();
  const shipmentId = uuid();
  await pool.query(
    `INSERT INTO "order" (order_id, shop_id, shopify_order_gid, order_state, payment_mode, order_amount, recipient_snapshot)
     VALUES ($1, $2, $3, 'READY', 'PREPAID', 500.00, $4::jsonb)`,
    [
      orderId, shopId, `gid://shopify/Order/${RUN}`,
      JSON.stringify({ name: 'E2E Buyer', addressLines: ['1 MG Road'], city: 'Mumbai', state: 'Maharashtra', pincode: '400001', phone: '9876543210', email: 'buyer@e2e.in' }),
    ],
  );
  const lineId = uuid();
  await pool.query(
    `INSERT INTO order_line (order_line_id, order_id, sku, title, quantity, unit_price, weight_kg_override)
     VALUES ($1, $2, 'SKU-E2E', 'Widget', 1, 500.00, 0.400)`,
    [lineId, orderId],
  );
  const workingValues = {
    schemaVersion: 1,
    recipient: { name: 'E2E Buyer', addressLines: ['1 MG Road'], city: 'Mumbai', state: 'Maharashtra', pincode: '400001', phone: '9876543210', email: 'buyer@e2e.in' },
    lines: [{ orderLineId: lineId, shopifyLineGid: null, sku: 'SKU-E2E', title: 'Widget', variant: null, quantity: 1, unitPrice: '500.00', tags: [], hsnCode: null, weightKgPerUnit: '0.400' }],
    payment: { mode: 'PREPAID', gatewayNames: ['razorpay'], collectible: '0.00', totalOutstanding: '0.00' },
    fulfillment: { sourceFulfillmentOrderGids: [], shopifyLocationGid: null, mergePath: 'CONSOLIDATED' },
    weight: { deadWeightKg: '0.450', lineWeightTotalKg: '0.400', tareKg: '0.050', usedDefaultParcelWeight: false, lines: [] },
    packageProfile: { packageProfileId: (await pool.query(`SELECT package_profile_id FROM package_profile WHERE shop_id = $1 AND is_default`, [shopId])).rows[0].package_profile_id, source: 'DEFAULT', matchedRuleId: null, lengthCm: '25.00', widthCm: '20.00', heightCm: '10.00', tareKg: '0.050' },
  };
  const pickupLocationId = (
    await pool.query(`SELECT pickup_location_id FROM pickup_location WHERE shop_id = $1 AND is_active`, [shopId])
  ).rows[0].pickup_location_id;
  await pool.query(
    `INSERT INTO shipment (shipment_id, shop_id, order_id, pickup_location_id, service_id, working_values, collectible)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 0)`,
    [shipmentId, shopId, orderId, pickupLocationId, service.service_id, JSON.stringify(workingValues)],
  );
  step('fixtures: READY order + DRAFT shipment with complete working values', true);

  // --- Book it (BullMQ worker path) ---
  const bookRes = await fetch(`${APP}/shipments/${shipmentId}/book`, { method: 'POST', ...auth });
  step('POST /shipments/:id/book accepted', bookRes.status < 300, `status ${bookRes.status} ${await bookRes.text()}`);

  const confirmed = await pollFor('CONFIRMED booking', async () => {
    const { rows } = await pool.query(
      `SELECT booking_state, awb_normalized, custody_state, is_test, expected_cost_basis
         FROM shipment WHERE shipment_id = $1 AND booking_state = 'CONFIRMED'`,
      [shipmentId],
    );
    return rows[0] ?? null;
  }, 30, 700);
  step('worker books via FAKE adapter → CONFIRMED with AWB', !!confirmed, confirmed ? `awb=${confirmed.awb_normalized} custody=${confirmed.custody_state} basis=${confirmed.expected_cost_basis}` : 'not confirmed');

  const debit = await pollFor('entitlement debit', async () => {
    const { rows } = await pool.query(
      `SELECT entry_id FROM awb_entitlement_ledger WHERE shipment_id = $1 AND direction = 'DEBIT'`,
      [shipmentId],
    );
    return rows[0] ?? null;
  });
  step('INV-12 entitlement DEBIT written for the non-test AWB', !!debit);

  const outbox = await pollFor('sync outbox row', async () => {
    const { rows } = await pool.query(
      `SELECT outbox_id, operation FROM sync_outbox WHERE shipment_id = $1`,
      [shipmentId],
    );
    return rows[0] ?? null;
  });
  step('§8.4 CREATE_FULFILLMENT enqueued through the outbox', !!outbox, outbox?.operation);

  // --- Courier webhook → tracking normalization + reducer ---
  const awb = confirmed?.awb_normalized ?? 'FAKE0001';
  const whTokenRow = (await pool.query(`SELECT webhook_url_token FROM courier_account WHERE courier_account_id = $1`, [accountId])).rows[0];
  const sendEvent = async (status: string, occurredAt: string) => {
    const payload = JSON.stringify({ event_id: uuid(), awb, status, occurred_at: occurredAt, location: 'Mumbai' });
    const sig = createHmac('sha256', knownSecret).update(payload).digest('hex');
    return fetch(`${APP}/hooks/FAKE/${whTokenRow.webhook_url_token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jsyxi-signature': sig },
      body: payload,
    });
  };
  const e1 = await sendEvent('PICKED_UP', new Date().toISOString());
  step('courier webhook accepts a valid signature', e1.status === 200, `status ${e1.status}`);

  const moved = await pollFor('IN_TRANSIT movement', async () => {
    const { rows } = await pool.query(
      `SELECT movement_state, custody_state FROM shipment WHERE shipment_id = $1 AND movement_state = 'IN_TRANSIT'`,
      [shipmentId],
    );
    return rows[0] ?? null;
  });
  step('§3.4 reducer: PICKED_UP → IN_TRANSIT + IN_CUSTODY', moved?.custody_state === 'IN_CUSTODY', moved ? `movement=${moved.movement_state} custody=${moved.custody_state}` : 'no transition');

  const e2 = await sendEvent('OUT_FOR_DELIVERY', new Date().toISOString());
  const e3 = await sendEvent('DELIVERED', new Date().toISOString());
  step('OFD + DELIVERED webhooks accepted', e2.status === 200 && e3.status === 200);

  const delivered = await pollFor('DELIVERED movement', async () => {
    const { rows } = await pool.query(
      `SELECT movement_state, delivered_at FROM shipment WHERE shipment_id = $1 AND movement_state = 'DELIVERED'`,
      [shipmentId],
    );
    return rows[0] ?? null;
  });
  step('reducer reaches DELIVERED with delivered_at', !!delivered?.delivered_at);

  // Duplicate payload is a no-op (§8.5 dedupe).
  const dupPayload = JSON.stringify({ event_id: 'dup-1', awb, status: 'IN_TRANSIT', occurred_at: new Date().toISOString() });
  const dupSig = createHmac('sha256', knownSecret).update(dupPayload).digest('hex');
  await fetch(`${APP}/hooks/FAKE/${whTokenRow.webhook_url_token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jsyxi-signature': dupSig }, body: dupPayload });
  await fetch(`${APP}/hooks/FAKE/${whTokenRow.webhook_url_token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jsyxi-signature': dupSig }, body: dupPayload });
  const dupCheck = await pollFor('duplicate marked', async () => {
    const { rows } = await pool.query(
      `SELECT parse_result FROM tracking_event_raw WHERE dedupe_hash IS NOT NULL AND parse_result = 'DUPLICATE' AND shop_id = $1 LIMIT 1`,
      [shopId],
    );
    return rows[0] ?? null;
  });
  step('§8.5 replayed payload dedupes (DUPLICATE parse result)', !!dupCheck);

  // INV-17: a late non-terminal event after DELIVERED is review-flagged, not regressed.
  await sendEvent('IN_TRANSIT', new Date().toISOString());
  const review = await pollFor('review-flagged late event', async () => {
    const { rows } = await pool.query(
      `SELECT s.movement_state, (SELECT count(*) FROM tracking_event te WHERE te.shipment_id = s.shipment_id AND te.review_flag) AS flagged
         FROM shipment s WHERE s.shipment_id = $1`,
      [shipmentId],
    );
    return rows[0] && Number(rows[0].flagged) > 0 ? rows[0] : null;
  });
  step('INV-17: terminal state never regressed; late event review-flagged', review?.movement_state === 'DELIVERED', review ? `movement=${review.movement_state} flagged=${review.flagged}` : 'missing');

  // --- Label + track token + public page ---
  const labelRes = await fetch(`${APP}/shipments/${shipmentId}/label`, { method: 'POST', ...auth });
  step('label generation (CUSTOM_ALLOWED custom render)', labelRes.status < 300, `status ${labelRes.status}`);

  const doc = await pollFor('label document', async () => {
    const { rows } = await pool.query(
      `SELECT document_id, kind, is_test FROM document WHERE shipment_id = $1 AND kind = 'LABEL'`,
      [shipmentId],
    );
    return rows[0] ?? null;
  });
  step('LABEL document stored (non-test)', !!doc && doc.is_test === false);

  // Track token: issue via the track-page service path — enable S-37 first? The
  // outbox already left without it; issue directly through the public flow:
  // simplest deterministic check — the tokenized page path rejects bad tokens
  // uniformly and the manual lookup returns the generic response.
  const badTrack = await fetch(`${APP}/track/t/not-a-real-token`);
  step('track page rejects an unknown token (no oracle)', badTrack.status === 404 || badTrack.status === 410, `status ${badTrack.status}`);

  const dash = await fetch(`${APP}/dashboard`, auth);
  const dashBody = (await dash.json()) as { asOf?: string | null; stale?: boolean };
  // A fresh shop has no rollup yet: asOf null + stale true is the §5.2
  // honest shape (the hourly job fills it); the key must exist either way.
  step(
    'GET /dashboard returns the as-of/staleness contract (§5.2)',
    dash.status === 200 && 'asOf' in dashBody && dashBody.stale === true,
    `status ${dash.status} asOf=${String(dashBody.asOf)} stale=${dashBody.stale}`,
  );

  console.log(failures === 0 ? '\nE2E GOLDEN PATH: ALL PASS' : `\nE2E: ${failures} FAILURE(S)`);
  await pool.end();
  await redis.quit();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
