/**
 * Database invariant smoke tests — runs the §6 guards against a LIVE
 * PostgreSQL as the least-privilege jsyxi_app role (grants included).
 * Usage: npm run smoke:db  (expects a migrated jsyxi DB on DATABASE_URL /
 * DATABASE_APP_URL — the throwaway cluster from README's dev setup works).
 */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL,
});

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: ${(err as Error).message.split('\n')[0]}`);
  }
}
async function expectReject(name: string, sql: string, params: unknown[] = []) {
  await check(name, async () => {
    try {
      await pool.query(sql, params);
      throw new Error('statement unexpectedly succeeded');
    } catch (err) {
      if ((err as Error).message === 'statement unexpectedly succeeded') throw err;
      // Any DB-level rejection (trigger exception or permission denied) is a pass.
    }
  });
}
const uuid = () => crypto.randomUUID();

async function main() {
  // Fixtures: a shop + order + account context.
  const shopId = uuid();
  await pool.query(
    `INSERT INTO shop (shop_id, shopify_shop_gid, myshopify_domain)
     VALUES ($1, $2, 'smoke.myshopify.com')`,
    [shopId, `gid://shopify/Shop/${Date.now()}`],
  );
  const orderId = uuid();
  await pool.query(
    `INSERT INTO "order" (order_id, shop_id, shopify_order_gid) VALUES ($1, $2, $3)`,
    [orderId, shopId, `gid://shopify/Order/${Date.now()}`],
  );

  await check('INV-24: first default package profile inserts', async () => {
    await pool.query(
      `INSERT INTO package_profile (shop_id, name, length_cm, width_cm, height_cm, tare_kg, is_default)
       VALUES ($1, 'p1', 10, 10, 10, 0.05, true)`,
      [shopId],
    );
  });
  await expectReject(
    'INV-24: second default package profile rejected',
    `INSERT INTO package_profile (shop_id, name, length_cm, width_cm, height_cm, tare_kg, is_default)
     VALUES ($1, 'p2', 10, 10, 10, 0.05, true)`,
    [shopId],
  );
  await expectReject(
    'INV-24: default package profile cannot be deleted',
    `DELETE FROM package_profile WHERE shop_id = $1 AND is_default`,
    [shopId],
  );

  await check('INV-3: first active pickup location inserts', async () => {
    await pool.query(
      `INSERT INTO pickup_location (shop_id, name, pincode) VALUES ($1, 'wh', '380015')`,
      [shopId],
    );
  });
  await expectReject(
    'INV-3: second active pickup location rejected',
    `INSERT INTO pickup_location (shop_id, name, pincode) VALUES ($1, 'wh2', '110001')`,
    [shopId],
  );

  // Append-only tables raise via trigger (role revoke is the second layer).
  await check('audit_log INSERT allowed (append-only tables take inserts)', async () => {
    await pool.query(`INSERT INTO audit_log (actor_kind, action) VALUES ('SYSTEM', 'smoke')`);
  });
  await expectReject('audit_log UPDATE rejected (append-only)', `UPDATE audit_log SET action = 'tampered'`);

  // INV-12 ledger: one debit, at most one reversal, no updates.
  const subId = uuid();
  const planId = (await pool.query(`SELECT plan_id FROM plan WHERE code = 'TRIAL'`)).rows[0].plan_id;
  await pool.query(
    `INSERT INTO subscription (subscription_id, shop_id, plan_id, cycle_start_at, state)
     VALUES ($1, $2, $3, now(), 'TRIALING')`,
    [subId, shopId, planId],
  );
  const shipmentId = uuid();
  await check('INV-12: first DEBIT inserts', async () => {
    await pool.query(
      `INSERT INTO awb_entitlement_ledger (shop_id, subscription_id, cycle_start_at, shipment_id, direction)
       VALUES ($1, $2, now(), $3, 'DEBIT')`,
      [shopId, subId, shipmentId],
    );
  });
  await expectReject(
    'INV-12: second DEBIT for the same shipment rejected',
    `INSERT INTO awb_entitlement_ledger (shop_id, subscription_id, cycle_start_at, shipment_id, direction)
     VALUES ($1, $2, now(), $3, 'DEBIT')`,
    [shopId, subId, shipmentId],
  );
  await expectReject(
    'INV-12: ledger UPDATE rejected (append-only)',
    `UPDATE awb_entitlement_ledger SET direction = 'REVERSAL' WHERE shipment_id = $1`,
    [shipmentId],
  );

  // Shipment guards (partitioned table).
  const shipId2 = uuid();
  await check('shipment inserts into a monthly partition', async () => {
    await pool.query(
      `INSERT INTO shipment (shipment_id, shop_id, order_id, created_at)
       VALUES ($1, $2, $3, '2026-08-15T00:00:00Z')`,
      [shipId2, shopId, orderId],
    );
    const { rows } = await pool.query(
      `SELECT tableoid::regclass::text AS part FROM shipment WHERE shipment_id = $1`,
      [shipId2],
    );
    if (!/shipment_2026_08/.test(rows[0].part)) throw new Error(`landed in ${rows[0].part}`);
  });
  await check('shipment far-future row falls into the default partition', async () => {
    await pool.query(
      `INSERT INTO shipment (shipment_id, shop_id, order_id, created_at)
       VALUES ($1, $2, $3, '2030-01-01T00:00:00Z')`,
      [uuid(), shopId, orderId],
    );
  });

  // INV-10 snapshot write-once.
  const shipId3 = uuid();
  await pool.query(
    `INSERT INTO shipment (shipment_id, shop_id, order_id) VALUES ($1, $2, $3)`,
    [shipId3, shopId, orderId],
  );
  await check('INV-10: snapshot write at DRAFT→QUEUED allowed', async () => {
    await pool.query(
      `UPDATE shipment SET snapshot = '{"v":1}'::jsonb, booking_state = 'QUEUED'
        WHERE shipment_id = $1`,
      [shipId3],
    );
  });
  await expectReject(
    'INV-10: later snapshot modification rejected',
    `UPDATE shipment SET snapshot = '{"v":2}'::jsonb WHERE shipment_id = $1`,
    [shipId3],
  );
  await expectReject(
    '§10.4: working values frozen from QUEUED onward',
    `UPDATE shipment SET working_values = '{"x":1}'::jsonb WHERE shipment_id = $1`,
    [shipId3],
  );

  // INV-19: is_test set at CONFIRMED, immutable after.
  const shipId4 = uuid();
  await pool.query(
    `INSERT INTO shipment (shipment_id, shop_id, order_id) VALUES ($1, $2, $3)`,
    [shipId4, shopId, orderId],
  );
  await check('INV-19: is_test set at CONFIRMED allowed', async () => {
    await pool.query(
      `UPDATE shipment SET booking_state = 'CONFIRMED', is_test = true WHERE shipment_id = $1`,
      [shipId4],
    );
  });
  await expectReject(
    'INV-19: is_test change after CONFIRMED rejected',
    `UPDATE shipment SET is_test = false WHERE shipment_id = $1`,
    [shipId4],
  );

  // INV-9: one collectible-bearing shipment per order.
  const sA = uuid();
  const sB = uuid();
  await pool.query(
    `INSERT INTO shipment (shipment_id, shop_id, order_id) VALUES ($1, $2, $3), ($4, $2, $3)`,
    [sA, shopId, orderId, sB],
  );
  await check('INV-9: first collectible carrier accepted', async () => {
    await pool.query(
      `UPDATE shipment SET collectible = 100.00, awb_normalized = 'SMOKE1' WHERE shipment_id = $1`,
      [sA],
    );
  });
  await expectReject(
    'INV-9: second collectible carrier on the same order rejected',
    `UPDATE shipment SET collectible = 50.00, awb_normalized = 'SMOKE2' WHERE shipment_id = $1`,
    [sB],
  );

  // INV-11 sealed versions.
  const courierId = (await pool.query(`SELECT courier_id FROM courier LIMIT 1`)).rows[0].courier_id;
  const serviceId = (
    await pool.query(`SELECT service_id FROM service WHERE courier_id = $1 LIMIT 1`, [courierId])
  ).rows[0].service_id;
  const accountId = uuid();
  await pool.query(
    `INSERT INTO courier_account (courier_account_id, shop_id, courier_id, webhook_url_token)
     VALUES ($1, $2, $3, $4)`,
    [accountId, shopId, courierId, uuid().replaceAll('-', '')],
  );
  const zoneMapId = uuid();
  const postalVersionId = uuid();
  await pool.query(
    `INSERT INTO postal_zone_master_version (postal_version_id, label, effective_from)
     VALUES ($1, 'smoke', '2026-01-01')`,
    [postalVersionId],
  );
  await pool.query(
    `INSERT INTO commercial_zone_map (zone_map_id, shop_id, service_id, label, effective_from, postal_version_id)
     VALUES ($1, $2, $3, 'zm', '2026-01-01', $4)`,
    [zoneMapId, shopId, serviceId, postalVersionId],
  );
  const rateCardId = uuid();
  await pool.query(
    `INSERT INTO rate_card (rate_card_id, shop_id, service_id, courier_account_id, name)
     VALUES ($1, $2, $3, $4, 'rc')`,
    [rateCardId, shopId, serviceId, accountId],
  );
  const rcvId = uuid();
  await pool.query(
    `INSERT INTO rate_card_version (rate_card_version_id, rate_card_id, effective_from, zone_map_id)
     VALUES ($1, $2, '2026-01-01', $3)`,
    [rcvId, rateCardId, zoneMapId],
  );
  await check('INV-11: sealing an unused version allowed', async () => {
    await pool.query(`UPDATE rate_card_version SET is_sealed = true WHERE rate_card_version_id = $1`, [rcvId]);
  });
  await expectReject(
    'INV-11: sealed version cannot be edited',
    `UPDATE rate_card_version SET fuel_pct = 0.1 WHERE rate_card_version_id = $1`,
    [rcvId],
  );
  await expectReject(
    'INV-11: children of a sealed version are frozen',
    `INSERT INTO rate_card_slab (rate_card_version_id, zone, base_weight_kg, base_rate, additional_step_kg, additional_rate)
     VALUES ($1, 'C', 0.5, 42, 0.5, 38)`,
    [rcvId],
  );

  // §3.30 enum gained COD_UNCONFIRMED (ADD-28, migration 0014).
  await check('ADD-28: COD_UNCONFIRMED is a valid §3.30 value', async () => {
    await pool.query(
      `UPDATE shipment SET booking_state = 'NEEDS_MANUAL_ASSIGNMENT',
              manual_assignment_reason = 'COD_UNCONFIRMED'
        WHERE shipment_id = $1`,
      [shipId3],
    );
  });

  // §10.4 recon row guard.
  const batchId = uuid();
  await pool.query(
    `INSERT INTO recon_freight_batch (batch_id, shop_id, courier_account_id, batch_reference,
        filename, content_hash, tax_treatment)
     VALUES ($1, $2, $3, 'FREIGHT-20260807-0001', 'f.csv', $4, 'TAX_INCLUSIVE')`,
    [batchId, shopId, accountId, uuid()],
  );
  const rowId = uuid();
  await pool.query(
    `INSERT INTO recon_freight_row (row_id, batch_id, awb_normalized, invoiced_amount)
     VALUES ($1, $2, 'SMOKE1', 100.00)`,
    [rowId, batchId],
  );
  await check('§10.4: workflow_state updates allowed on recon rows', async () => {
    await pool.query(
      `UPDATE recon_freight_row SET workflow_state = 'ACCEPTED' WHERE row_id = $1`,
      [rowId],
    );
  });
  await expectReject(
    '§10.4: imported invoiced_amount is immutable',
    `UPDATE recon_freight_row SET invoiced_amount = 999 WHERE row_id = $1`,
    [rowId],
  );
  await expectReject(
    '§10.4: mismatch flags are immutable',
    `UPDATE recon_freight_row SET flag_review = true WHERE row_id = $1`,
    [rowId],
  );

  // §3.28: ACCEPTED_WITH_REMARK requires the remark (CHECK).
  await expectReject(
    '§3.28: ACCEPTED_WITH_REMARK without remark rejected',
    `UPDATE recon_freight_batch SET control_total_state = 'ACCEPTED_WITH_REMARK' WHERE batch_id = $1`,
    [batchId],
  );

  // INV-13 atomic invoice sequence upsert.
  await check('INV-13: atomic sequence allocation returns increasing numbers', async () => {
    const a = await pool.query(
      `INSERT INTO invoice_number_sequence (shop_id, gstin, financial_year, series_code, next_number)
       VALUES ($1, 'GSTIN1', '2026-27', 'INV', 1)
       ON CONFLICT (shop_id, gstin, financial_year, series_code)
       DO UPDATE SET next_number = invoice_number_sequence.next_number + 1
       RETURNING next_number`,
      [shopId],
    );
    const b = await pool.query(
      `INSERT INTO invoice_number_sequence (shop_id, gstin, financial_year, series_code, next_number)
       VALUES ($1, 'GSTIN1', '2026-27', 'INV', 1)
       ON CONFLICT (shop_id, gstin, financial_year, series_code)
       DO UPDATE SET next_number = invoice_number_sequence.next_number + 1
       RETURNING next_number`,
      [shopId],
    );
    if (b.rows[0].next_number !== a.rows[0].next_number + 1) {
      throw new Error(`sequence did not increase: ${a.rows[0].next_number} → ${b.rows[0].next_number}`);
    }
  });

  // Partition helpers exist and work.
  await check('partition helpers create next months idempotently', async () => {
    await pool.query(`SELECT create_shipment_partition(2027, 7)`);
    await pool.query(`SELECT create_shipment_partition(2027, 7)`);
    await pool.query(`SELECT create_tracking_partition('tracking_event_raw', 2027, 7)`);
  });

  // Least-privilege spot checks: app role cannot mutate append-only or enum DDL.
  await expectReject(
    'jsyxi_app cannot CREATE TABLE (no schema DDL rights)',
    `CREATE TABLE smoke_ddl (id int)`,
  );

  console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
