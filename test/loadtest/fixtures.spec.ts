import { describe, expect, it } from 'vitest';
import {
  buildOrderValues,
  buildWorkingValues,
  createFixtures,
  destroyFixtures,
} from '../../scripts/loadtest/fixtures';
import { FakeDb, MASTER_KEY_HEX } from './helpers';

/**
 * Fixture SQL correctness against the mapper's shape (order-mapper.ts) and
 * the 0003/0004/0006/0008 column shapes — with a recording FakeDb, never a
 * live database. If the app's schema or mapper drifts, these assertions
 * fail before a load run ever touches postgres.
 */

function wiredDb(): FakeDb {
  return new FakeDb()
    .on(/INSERT INTO courier /, () => ({ rows: [{ courier_id: 'c-1' }] }))
    .on(/INSERT INTO service /, () => ({ rows: [{ service_id: 'svc-1' }] }))
    .on(/INSERT INTO service_version/, () => ({ rows: [{ service_version_id: 'sv-1' }] }))
    .on(/INSERT INTO plan /, () => ({ rows: [{ plan_id: 'plan-1' }] }))
    .on(/INSERT INTO shop /, () => ({ rows: [{ shop_id: 'shop-1' }] }))
    .on(/INSERT INTO shop_member/, () => ({ rows: [{ member_id: 'mem-1' }] }))
    .on(/INSERT INTO pickup_location/, () => ({ rows: [{ pickup_location_id: 'pl-1' }] }))
    .on(/INSERT INTO package_profile/, () => ({ rows: [{ package_profile_id: 'pp-1' }] }))
    .on(/INSERT INTO courier_account/, () => ({ rows: [{ courier_account_id: 'ca-1' }] }))
    .on(/INSERT INTO merchant_service/, () => ({ rows: [{ merchant_service_id: 'ms-1' }] }))
    .on(/INSERT INTO "order"/, () => ({ rows: [{ order_id: 'o-1' }] }))
    .on(/INSERT INTO order_line/, () => ({ rows: [{ order_line_id: 'ol-1' }] }));
}

describe('createFixtures', () => {
  it('creates a LIVE-mode courier account with §8.5 webhook material', async () => {
    const db = wiredDb();
    await createFixtures(db, { runId: 't1', shopCount: 1, ordersPerShop: 1, masterKeyHex: MASTER_KEY_HEX });

    const accountSql = db.textFor(/INSERT INTO courier_account/)[0] ?? '';
    expect(accountSql).toContain("'LIVE'"); // LIVE mode — INV-19 live path
    expect(accountSql).toContain('webhook_url_token');
    expect(accountSql).toContain('webhook_secret_encrypted');
    // Credentials + webhook secret are bytea ciphertexts, never plaintext.
    const accountParams = db.paramsFor(/INSERT INTO courier_account/)[0] ?? [];
    expect(accountParams[1]).toBeInstanceOf(Buffer);
    expect(accountParams[3]).toBeInstanceOf(Buffer);
    expect(JSON.stringify(accountParams)).not.toContain('webhook-secret');
  });

  it('sets the S-22 default chain to the merchant_service id', async () => {
    const db = wiredDb();
    await createFixtures(db, { runId: 't1', shopCount: 1, ordersPerShop: 1, masterKeyHex: MASTER_KEY_HEX });
    const params = db.paramsFor(/INSERT INTO order_sync_settings/)[0] ?? [];
    expect(params[0]).toBe('shop-1');
    expect(JSON.parse(params[1] as string)).toEqual(['ms-1']);
  });

  it('inserts orders mirroring the mapper output, tagged with the run id', async () => {
    const db = wiredDb();
    await createFixtures(db, { runId: 'runxyz', shopCount: 1, ordersPerShop: 2, masterKeyHex: MASTER_KEY_HEX });

    const orderSql = db.textFor(/INSERT INTO "order"/)[0] ?? '';
    // Column list mirrors migration 0003 "order" + the mapper's fields.
    for (const col of [
      'shopify_order_gid', 'shopify_order_number', 'created_at_shopify',
      'order_state', 'payment_mode', 'order_amount', 'recipient_snapshot',
      'is_test_order', 'source',
    ]) {
      expect(orderSql).toContain(col);
    }
    expect(orderSql).toContain("'READY'");
    expect(orderSql).toContain("'PREPAID'");
    expect(orderSql).toContain('false'); // is_test_order literal — INV-19 live path

    const orderParams = db.paramsFor(/INSERT INTO "order"/);
    expect(orderParams).toHaveLength(2);
    expect(orderParams[0]?.[1]).toBe('gid://shopify/Order/LTrunxyz-0'); // run-tagged
    expect(orderParams[1]?.[1]).toBe('gid://shopify/Order/LTrunxyz-1');

    // recipient_snapshot is the mapper's WorkingRecipient shape.
    const recipient = JSON.parse(orderParams[0]?.[7] as string);
    expect(recipient).toMatchObject({
      name: expect.any(String),
      addressLines: [expect.any(String)],
      city: expect.any(String),
      state: expect.any(String),
      phone: expect.stringMatching(/^\d{10}$/), // INV-7
      email: expect.any(String),
    });
    expect(recipient.pincode).toMatch(/^\d{6}$/); // INV-7
  });

  it('writes DRAFT shipments whose working_values pass every INV-7 block', async () => {
    const db = wiredDb();
    await createFixtures(db, { runId: 't1', shopCount: 1, ordersPerShop: 1, masterKeyHex: MASTER_KEY_HEX });

    const shipmentSql = db.textFor(/INSERT INTO shipment/)[0] ?? '';
    expect(shipmentSql).toContain("'DRAFT'");
    expect(shipmentSql).toContain('false'); // is_test literal (INV-19, immutable)

    const params = db.paramsFor(/INSERT INTO shipment/)[0] ?? [];
    expect(params[1]).toBe('o-1'); // order_id
    expect(params[2]).toBe('pl-1'); // pickup_location_id — INV-7 PICKUP_LOCATION
    const wv = JSON.parse(params[3] as string);

    // INV-7 recipient / weight / dimensions / payment blocks (eligibility.ts).
    expect(wv.recipient.name).toBeTruthy();
    expect(wv.recipient.addressLines.length).toBeGreaterThan(0);
    expect(wv.recipient.pincode).toMatch(/^\d{6}$/);
    expect(wv.recipient.phone).toMatch(/^\d{10}$/);
    expect(wv.lines[0].quantity).toBeGreaterThan(0); // ALLOCATED_LINES
    expect(Number(wv.weight.deadWeightKg)).toBeGreaterThan(0); // POSITIVE_WEIGHT
    expect(Number(wv.packageProfile.lengthCm)).toBeGreaterThan(0); // POSITIVE_DIMENSIONS
    expect(Number(wv.packageProfile.widthCm)).toBeGreaterThan(0);
    expect(Number(wv.packageProfile.heightCm)).toBeGreaterThan(0);
    expect(wv.payment.mode).toBe('PREPAID'); // PAYMENT_MODE resolved
    expect(wv.payment.collectible).toBe('0.00'); // COLLECTIBLE ≥ 0
    // The packageProfile block references the shop's INV-24 default profile.
    expect(wv.packageProfile.packageProfileId).toBe('pp-1');
  });

  it('stores only the session token HASH (RW-04), never the raw token', async () => {
    const db = wiredDb();
    const fixtures = await createFixtures(db, {
      runId: 't1', shopCount: 1, ordersPerShop: 1, masterKeyHex: MASTER_KEY_HEX,
    });
    const params = db.paramsFor(/INSERT INTO member_session/)[0] ?? [];
    const tokenHash = params[2] as string;
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const raw = fixtures.shops[0]?.sessionToken as string;
    expect(raw).toBeTruthy();
    expect(tokenHash).not.toBe(raw);
  });

  it('refuses to encrypt without the app master key', async () => {
    const db = wiredDb();
    await expect(
      createFixtures(db, { shopCount: 1, ordersPerShop: 1, masterKeyHex: '' }),
    ).rejects.toThrow(/MASTER_KEY_HEX/);
  });

  it('destroyFixtures scopes every delete to the run’s own shops', async () => {
    const db = new FakeDb().on(/SELECT shop_id FROM shop/, () => ({ rows: [{ shop_id: 'shop-9' }] }));
    const errors = await destroyFixtures(db, 'runxyz');
    expect(errors).toEqual([]);
    const lookup = db.paramsFor(/SELECT shop_id FROM shop/)[0] ?? [];
    expect(lookup[0]).toBe('loadtest-runxyz-%.myshopify.com');
    // Every delete is shop-scoped (INV-1) and only touches shop-9.
    for (const q of db.queries.filter((q) => q.text.startsWith('DELETE'))) {
      expect(q.params).toEqual(['shop-9']);
    }
    expect(db.textFor(/DELETE FROM shop /).length).toBe(1);
  });
});

describe('pure fixture builders', () => {
  it('buildOrderValues emits mapper-shaped money and identity fields', () => {
    const v = buildOrderValues('r1', 0, 3);
    expect(v.shopifyOrderGid).toBe('gid://shopify/Order/LTr1-3');
    expect(v.orderAmount).toBe('499.00'); // 2dp NUMERIC text (§4.1, INV-15)
    expect(v.presentmentCurrency).toBe('INR');
    expect(v.pincode).toMatch(/^\d{6}$/);
  });

  it('buildWorkingValues carries the week-4 shape additively', () => {
    const wv = buildWorkingValues({
      orderLineId: 'ol', shopifyLineGid: 'gid://shopify/LineItem/1',
      recipient: { name: 'R' }, packageProfileId: 'pp', evaluatedAt: '2026-08-07T00:00:00.000Z',
    });
    expect(wv.schemaVersion).toBe(1);
    expect(wv.fulfillment.mergePath).toBe('CONSOLIDATED'); // RV-11
    expect(wv.validation.ready).toBe(true);
    expect(wv.weight.usedDefaultParcelWeight).toBe(false);
  });
});
