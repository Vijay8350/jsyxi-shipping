import { createHash, randomBytes } from 'node:crypto';
import { EnvelopeCipher } from '../../src/common/envelope';
import { Queryable } from './lib';

/**
 * §5.1 load-test fixtures — deterministic synthetic LIVE-mode data for one
 * load run, tagged with a run id so it can be found and destroyed.
 *
 * ⚠ DISPOSABLE LOCAL DATABASES ONLY. Every row here deliberately carries
 * is_test / is_test_order = false: the §5.1 capacity figures exclude test
 * shipments (INV-19), so the harness must exercise the LIVE path — real
 * entitlement debits, real sync-back outbox rows, real rollup inputs. The
 * localhost guard in lib.ts is called by run.ts before any of this runs.
 *
 * What is created per shop (mirroring the order-sync mapper's output —
 * src/modules/order-sync/order-mapper.ts — and migrations 0003/0004/0006/
 * 0008 column shapes):
 *  - shop (TRIALING) + LOADTEST plan subscription with a huge AWB allowance
 *    (booking's §9.5.6 entitlement gate must not throttle a capacity run);
 *  - an OWNER shop_member + a member_session (token returned; the dashboard /
 *    bulk endpoints are SessionGuard-protected);
 *  - the INV-3 single active pickup_location and the INV-24 default
 *    package_profile;
 *  - the global FAKE courier + one service (cost_source NONE — see below) +
 *    service_version + the §3.6 courier_status_map rows for the fake's raw
 *    statuses;
 *  - a LIVE courier_account with envelope-encrypted credentials, the §8.5
 *    webhook URL token and signing secret, plus an enabled merchant_service;
 *  - order_sync_settings.default_chain = [merchant_service_id] (S-22), so a
 *    no-rule shipment routes to the fake (§9.4.4);
 *  - N orders (+order_line) and one DRAFT shipment each, with working_values
 *    complete enough to pass every INV-7 hard-block (recipient / positive
 *    weight / positive dimensions / pickup location / resolved payment mode /
 *    collectible) at queueBooking time.
 *
 * cost_source = NONE is deliberate: queueBooking then performs no adapter
 * getQuote, so the outage scenario can hold the §8.2 circuit breaker open
 * (Redis cf:cb:{accountId}) while booking intents keep queueing — the worker
 * fails fast pre-call and BullMQ retries the SAME intent (INV-5), which is
 * exactly the provider-outage backlog the §5.1 two-hour catch-up line item
 * describes.
 */

export interface FixtureShop {
  shopId: string;
  memberId: string;
  /** Raw session token (DB holds only its SHA-256 hash, RW-04). */
  sessionToken: string;
  courierAccountId: string;
  merchantServiceId: string;
  serviceId: string;
  pickupLocationId: string;
  packageProfileId: string;
  /** §8.5 inbound webhook path token + plaintext signing secret. */
  webhookUrlToken: string;
  webhookSecret: string;
  orderIds: string[];
}

export interface LoadTestFixtures {
  runId: string;
  shops: FixtureShop[];
}

export interface FixtureOptions {
  runId?: string;
  shopCount: number;
  ordersPerShop: number;
  /** App MASTER_KEY_HEX — fixtures encrypt credentials with the app's own
   *  envelope format so the running app can decrypt them (§5.7 control 1). */
  masterKeyHex: string;
}

export const FAKE_SERVICE_CODE = 'FAKE_SURFACE';

/** §3.6 status map rows for the fake's raw statuses (stored case-folded). */
const FAKE_STATUS_MAP: Array<[string, string]> = [
  ['pickup_scheduled', 'PICKUP_SCHEDULED'],
  ['picked_up', 'PICKED_UP'],
  ['in_transit', 'IN_TRANSIT'],
  ['out_for_delivery', 'OUT_FOR_DELIVERY'],
  ['delivered', 'DELIVERED'],
  ['undelivered_attempt', 'UNDELIVERED_ATTEMPT'],
  ['rto_initiated', 'RTO_INITIATED'],
  ['rto_in_transit', 'RTO_IN_TRANSIT'],
  ['rto_delivered', 'RTO_DELIVERED'],
  ['cancelled_by_courier', 'CANCELLED_BY_COURIER'],
];

/** Metro pincodes cycled across orders (never '999999*' — the fake treats
 *  those as unserviceable, §15.1 convention). */
const DEST_PINCODES = ['110001', '400001', '560001', '600001', '700001'];
const ORIGIN_PINCODE = '122001';

export function newRunId(): string {
  // Timestamped but collision-safe; embedded in every synthetic gid/domain.
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The order row values, mirroring MappedOrder (order-mapper.ts) one column
 *  per field so drift between fixture and mapper is visible in tests. */
export function buildOrderValues(runId: string, shopSeq: number, i: number) {
  const n = shopSeq * 1_000_000 + i;
  const pincode = DEST_PINCODES[i % DEST_PINCODES.length] as string;
  const recipient = {
    name: `Loadtest Recipient ${n}`,
    addressLines: [`${(i % 900) + 1} Loadtest Marg`],
    city: 'New Delhi',
    state: 'Delhi',
    pincode,
    phone: `98${String(10000000 + (n % 89999999)).padStart(8, '0')}`, // INV-7: 10 digits
    email: `loadtest-${runId}-${n}@example.invalid`,
  };
  return {
    shopifyOrderGid: `gid://shopify/Order/LT${runId}-${n}`,
    shopifyOrderNumber: `LT${n}`,
    createdAtShopify: new Date(Date.now() - 3600_000).toISOString(),
    orderAmount: '499.00', // F-17, 2dp NUMERIC text (§4.1)
    presentmentAmount: '499.00',
    presentmentCurrency: 'INR',
    recipientSnapshot: recipient,
    pincode,
  };
}

/** §2.9 working_values, complete enough for every INV-7 hard-block
 *  (eligibility.ts) — weight/packageProfile blocks follow the week-4 shape
 *  (working-values-week4.types.ts). */
export function buildWorkingValues(input: {
  orderLineId: string;
  shopifyLineGid: string;
  recipient: unknown;
  packageProfileId: string;
  evaluatedAt: string;
}) {
  return {
    schemaVersion: 1,
    recipient: input.recipient,
    lines: [
      {
        orderLineId: input.orderLineId,
        shopifyLineGid: input.shopifyLineGid,
        sku: `LT-SKU`,
        title: 'Loadtest Widget',
        variant: null,
        quantity: 1,
        unitPrice: '499.00',
        tags: [],
        hsnCode: null,
        weightKgPerUnit: '0.500', // RV-02 per unit
      },
    ],
    payment: {
      mode: 'PREPAID', // §3.5 already derived — fixtures are post-derivation rows
      gatewayNames: ['manual'],
      collectible: '0.00', // F-15; PREPAID carries no collectible
    },
    fulfillment: {
      sourceFulfillmentOrderGids: [],
      shopifyLocationGid: null,
      mergePath: 'CONSOLIDATED', // RV-11
    },
    weight: {
      // F-24: 0.500 content + 0.050 tare; deadWeightKg must be > 0 (INV-7).
      deadWeightKg: '0.550',
      lineWeightTotalKg: '0.500',
      tareKg: '0.050',
      usedDefaultParcelWeight: false,
      lines: [],
    },
    packageProfile: {
      packageProfileId: input.packageProfileId,
      source: 'DEFAULT',
      matchedRuleId: null,
      lengthCm: '10.00',
      widthCm: '10.00',
      heightCm: '5.00',
      tareKg: '0.050',
    },
    validation: { ready: true, failures: [], evaluatedAt: input.evaluatedAt },
  };
}

async function one(db: Queryable, text: string, params: unknown[]): Promise<any> {
  const res = await db.query(text, params);
  if (!res.rows[0]) throw new Error(`fixture insert returned no row: ${text.slice(0, 60)}…`);
  return res.rows[0];
}

export async function createFixtures(
  db: Queryable,
  opts: FixtureOptions,
): Promise<LoadTestFixtures> {
  // The localhost guard (lib.ts) runs in run.ts BEFORE any connection is
  // opened; nothing here may be reached with a remote DATABASE_URL.
  const runId = opts.runId ?? newRunId();
  const cipher = EnvelopeCipher.fromHex(opts.masterKeyHex);

  // The global FAKE courier family is shared across runs — upsert by code.
  const courier = await one(
    db,
    `INSERT INTO courier (code, name, kind, auth_pattern)
     VALUES ('FAKE', 'Fake Courier (§15.1)', 'DIRECT', 'KEY_PASTE')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING courier_id`,
    [],
  );
  const service = await one(
    db,
    `INSERT INTO service (courier_id, code, name, label_mode, cost_source)
     VALUES ($1, $2, 'Fake Surface', 'COURIER_PDF_REQUIRED', 'NONE')
     ON CONFLICT (courier_id, code) DO UPDATE SET name = EXCLUDED.name
     RETURNING service_id`,
    [courier.courier_id, FAKE_SERVICE_CODE],
  );
  await one(
    db,
    `INSERT INTO service_version
       (service_id, effective_from, volumetric_divisor, min_billable_kg, billable_increment_kg, supports_cod)
     VALUES ($1, '2026-01-01', 5000, 0.5, 0.5, true)
     RETURNING service_version_id`,
    [service.service_id],
  );
  for (const [rawStatus, carrierStatus] of FAKE_STATUS_MAP) {
    await db.query(
      `INSERT INTO courier_status_map (courier_id, raw_status, carrier_event_status)
       VALUES ($1, $2, $3)
       ON CONFLICT (courier_id, raw_status) DO NOTHING`,
      [courier.courier_id, rawStatus, carrierStatus],
    );
  }

  // One high-allowance plan per process (global), so entitlement (§9.5.6)
  // never throttles a capacity run.
  const plan = await one(
    db,
    `INSERT INTO plan (code, name, awb_allowance_per_cycle, price, currency,
                       overage_unit_price, is_trial, is_active)
     VALUES ('LOADTEST', 'Load Test', 1000000000, 0, 'INR', 0, false, true)
     ON CONFLICT (code) DO UPDATE SET awb_allowance_per_cycle = EXCLUDED.awb_allowance_per_cycle
     RETURNING plan_id`,
    [],
  );

  const shops: FixtureShop[] = [];
  for (let s = 0; s < opts.shopCount; s += 1) {
    shops.push(await createShopFixtures(db, cipher, plan.plan_id, service.service_id, runId, s, opts.ordersPerShop));
  }
  return { runId, shops };
}

async function createShopFixtures(
  db: Queryable,
  cipher: EnvelopeCipher,
  planId: string,
  serviceId: string,
  runId: string,
  shopSeq: number,
  orderCount: number,
): Promise<FixtureShop> {
  const shop = await one(
    db,
    `INSERT INTO shop (shopify_shop_gid, myshopify_domain, account_state)
     VALUES ($1, $2, 'TRIALING')
     RETURNING shop_id`,
    [`gid://shopify/Shop/LT${runId}-${shopSeq}`, `loadtest-${runId}-${shopSeq}.myshopify.com`],
  );
  await db.query(
    `INSERT INTO subscription (shop_id, plan_id, cycle_start_at, cycle_end_at, state, capped_amount)
     VALUES ($1, $2, now() - interval '1 hour', now() + interval '1 day', 'TRIALING', 0)`,
    [shop.shop_id],
  );

  const member = await one(
    db,
    `INSERT INTO shop_member (shop_id, email, auth_source, role)
     VALUES ($1, $2, 'NATIVE', 'OWNER')
     RETURNING member_id`,
    [shop.shop_id, `loadtest-${runId}-${shopSeq}@example.invalid`],
  );
  const sessionToken = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO member_session (shop_id, member_id, token_hash, auth_source, expires_at)
     VALUES ($1, $2, $3, 'NATIVE', now() + interval '12 hours')`,
    [shop.shop_id, member.member_id, tokenHash(sessionToken)],
  );

  // INV-3: exactly one active pickup location per shop.
  const pickup = await one(
    db,
    `INSERT INTO pickup_location
       (shop_id, name, contact_name, phone, address_lines, city, state, pincode, is_active)
     VALUES ($1, 'Loadtest Origin', 'Loadtest Ops', '9811111111',
             ARRAY['1 Loadtest Warehouse'], 'Gurugram', 'Haryana', $2, true)
     RETURNING pickup_location_id`,
    [shop.shop_id, ORIGIN_PINCODE],
  );
  // INV-24: exactly one default package profile per shop.
  const pkg = await one(
    db,
    `INSERT INTO package_profile
       (shop_id, name, length_cm, width_cm, height_cm, tare_kg, is_default)
     VALUES ($1, 'Loadtest Parcel', 10.00, 10.00, 5.00, 0.050, true)
     RETURNING package_profile_id`,
    [shop.shop_id],
  );

  // §5.7 control 1 / RW-20: credentials + the §8.5 webhook secret are
  // envelope-encrypted exactly as the vault writes them, so the running app
  // decrypts them transparently.
  const credentialsLive = cipher.encrypt(JSON.stringify({ api_key: `loadtest-${runId}` }));
  const webhookSecret = randomBytes(24).toString('hex');
  const webhookSecretEncrypted = cipher.encrypt(JSON.stringify({ secret: webhookSecret }));
  const webhookUrlToken = `lt_${runId}_${shopSeq}_${randomBytes(12).toString('hex')}`;
  const account = await one(
    db,
    `INSERT INTO courier_account
       (shop_id, courier_id, mode, credentials_live_encrypted, health_state,
        webhook_url_token, webhook_secret_encrypted)
     SELECT $1, c.courier_id, 'LIVE', $2, 'HEALTHY', $3, $4
       FROM courier c WHERE c.code = 'FAKE'
     ON CONFLICT (shop_id, courier_id) DO NOTHING
     RETURNING courier_account_id`,
    [shop.shop_id, credentialsLive, webhookUrlToken, webhookSecretEncrypted],
  );
  const merchantService = await one(
    db,
    `INSERT INTO merchant_service (shop_id, courier_account_id, service_id, enabled)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (courier_account_id, service_id) DO UPDATE SET enabled = true
     RETURNING merchant_service_id`,
    [shop.shop_id, account.courier_account_id, serviceId],
  );

  // S-22 (§7.3): the no-rule default chain — an ordered jsonb array of
  // merchant_service ids (migration 0008).
  await db.query(
    `INSERT INTO order_sync_settings (shop_id, default_chain)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (shop_id) DO UPDATE SET default_chain = EXCLUDED.default_chain`,
    [shop.shop_id, JSON.stringify([merchantService.merchant_service_id])],
  );

  const orderIds: string[] = [];
  for (let i = 0; i < orderCount; i += 1) {
    orderIds.push(
      await createOrderWithDraftShipment(db, {
        runId,
        shopSeq,
        i,
        shopId: shop.shop_id,
        pickupLocationId: pickup.pickup_location_id,
        packageProfileId: pkg.package_profile_id,
      }),
    );
  }

  return {
    shopId: shop.shop_id,
    memberId: member.member_id,
    sessionToken,
    courierAccountId: account.courier_account_id,
    merchantServiceId: merchantService.merchant_service_id,
    serviceId,
    pickupLocationId: pickup.pickup_location_id,
    packageProfileId: pkg.package_profile_id,
    webhookUrlToken,
    webhookSecret,
    orderIds,
  };
}

async function createOrderWithDraftShipment(
  db: Queryable,
  args: {
    runId: string;
    shopSeq: number;
    i: number;
    shopId: string;
    pickupLocationId: string;
    packageProfileId: string;
  },
): Promise<string> {
  const v = buildOrderValues(args.runId, args.shopSeq, args.i);
  // Columns mirror the order-sync ingest insert (migration 0003 "order").
  // INV-19 note: is_test_order = false on purpose — see the header warning.
  const order = await one(
    db,
    `INSERT INTO "order"
       (shop_id, shopify_order_gid, shopify_order_number, created_at_shopify,
        order_state, payment_mode, cod_assignment_state, order_amount,
        cod_outstanding, presentment_amount, presentment_currency,
        recipient_snapshot, is_test_order, checkout_shipping_title,
        checkout_shipping_amount, source)
     VALUES ($1, $2, $3, $4, 'READY', 'PREPAID', 'NOT_APPLICABLE', $5,
             '0.00', $6, $7, $8::jsonb, false, 'Standard', '40.00', 'SHOPIFY')
     RETURNING order_id`,
    [
      args.shopId,
      v.shopifyOrderGid,
      v.shopifyOrderNumber,
      v.createdAtShopify,
      v.orderAmount,
      v.presentmentAmount,
      v.presentmentCurrency,
      JSON.stringify(v.recipientSnapshot),
    ],
  );
  const lineGid = `gid://shopify/LineItem/LT${args.runId}-${args.shopSeq}-${args.i}`;
  const line = await one(
    db,
    `INSERT INTO order_line
       (order_id, shopify_line_gid, sku, title, quantity, unit_price, weight_kg_override)
     VALUES ($1, $2, 'LT-SKU', 'Loadtest Widget', 1, '499.00', 0.500)
     RETURNING order_line_id`,
    [order.order_id, lineGid],
  );
  const working = buildWorkingValues({
    orderLineId: line.order_line_id,
    shopifyLineGid: lineGid,
    recipient: v.recipientSnapshot,
    packageProfileId: args.packageProfileId,
    evaluatedAt: new Date().toISOString(),
  });
  // DRAFT shipment with complete working values; service_id stays NULL so the
  // §9.4.4 routing evaluation walks the S-22 default chain. is_test = false
  // (INV-19: immutable after insert) — the LIVE path is the point.
  await db.query(
    `INSERT INTO shipment
       (shop_id, order_id, pickup_location_id, booking_state, collectible,
        is_test, working_values)
     VALUES ($1, $2, $3, 'DRAFT', 0, false, $4::jsonb)`,
    [args.shopId, order.order_id, args.pickupLocationId, JSON.stringify(working)],
  );
  return order.order_id as string;
}

/**
 * Best-effort teardown of one run's shops (children first — FKs are not
 * cascading). Only rows tagged with this run id are touched. A load run
 * writes many side tables (audit, ledger, traces, outbox, invoices…); each
 * delete is tolerant — a failure is collected, not thrown — because the
 * supported workflow is a disposable database where teardown is a
 * convenience, never a correctness requirement.
 */
export async function destroyFixtures(db: Queryable, runId: string): Promise<string[]> {
  const errors: string[] = [];
  const { rows: shops } = await db.query(
    `SELECT shop_id FROM shop WHERE myshopify_domain LIKE $1`,
    [`loadtest-${runId}-%.myshopify.com`],
  );
  const statements: Array<(shopId: string) => [string, unknown[]]> = [
    (id) => [`DELETE FROM tracking_event_raw WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM tracking_event WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM rule_evaluation_trace WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM sync_outbox WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM gst_invoice_line WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM gst_invoice WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM message_log WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM usage_record WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM awb_entitlement_ledger WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM dlq_item WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM courier_api_call WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM audit_log WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM booking_batch WHERE shop_id = $1`, [id]],
    (id) => [
      `DELETE FROM booking_intent WHERE shipment_id IN (SELECT shipment_id FROM shipment WHERE shop_id = $1)`,
      [id],
    ],
    (id) => [`DELETE FROM shipment WHERE shop_id = $1`, [id]],
    (id) => [
      `DELETE FROM order_line WHERE order_id IN (SELECT order_id FROM "order" WHERE shop_id = $1)`,
      [id],
    ],
    (id) => [`DELETE FROM "order" WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM merchant_service WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM courier_account WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM order_sync_settings WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM package_profile WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM pickup_location WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM member_session WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM shop_member WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM subscription WHERE shop_id = $1`, [id]],
    (id) => [`DELETE FROM shop WHERE shop_id = $1`, [id]],
  ];
  for (const { shop_id: shopId } of shops) {
    for (const build of statements) {
      const [text, params] = build(shopId);
      try {
        await db.query(text, params);
      } catch (err) {
        errors.push(`${text.slice(0, 50)}…: ${(err as Error).message}`);
      }
    }
  }
  return errors;
}
