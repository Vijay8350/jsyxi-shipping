import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { PrivacyRedactionService } from '../../src/modules/order-derivation/privacy-redaction.service';
import {
  FullRedactionService,
  REDACTED_KEY_PREFIX,
} from '../../src/modules/health/full-redaction.service';
import { MockTxPool, ORDER_ID, SHOP_ID, mockAudit } from '../order-sync/helpers';
import { validRecipient } from '../order-derivation/helpers';
import { mockRedis } from './helpers';

/**
 * §5.5 GDPR completion. Phase 1 (order.recipient_snapshot + working values +
 * track-token revocation) runs through the REAL PrivacyRedactionService
 * against the same MockTxPool; the phase-2 stores are asserted from the
 * recorded SQL and the erase/redis/dispatcher doubles.
 */

const SCOPE = {
  shopifyOrderIds: [555000111],
  email: 'buyer@example.in',
  phone: '9876543210',
};
const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';

function setup(pool: MockTxPool, opts: { redis?: ReturnType<typeof mockRedis> } = {}) {
  const audit = mockAudit();
  const trackTokens = {
    revokeForShipment: vi.fn(async () => 1),
    revokeAllForShop: vi.fn(async () => 2),
  };
  const phase1 = new PrivacyRedactionService(
    pool as unknown as Pool,
    audit as unknown as AuditService,
    trackTokens as never,
  );
  const redis = opts.redis ?? mockRedis();
  const dispatcher = {
    dispatch: vi.fn(async (_input: Record<string, unknown>) => ({
      messageId: 'm1',
      state: 'SENT',
    })),
  };
  const objects = { delete: vi.fn(async () => undefined) };
  const svc = new FullRedactionService(
    pool as unknown as Pool,
    audit as unknown as AuditService,
    phase1,
    trackTokens as never,
    redis as never,
    dispatcher as never,
    objects,
  );
  return { svc, audit, trackTokens, redis, dispatcher, objects };
}

/** Responders covering one customer with one order, one shipment, one label
 *  document. */
function customerPool() {
  return new MockTxPool()
    .on(/SELECT order_id FROM "order"/, [{ order_id: ORDER_ID }])
    .on(/UPDATE "order"/, [{ order_id: ORDER_ID }]) // phase 1
    .on(/SELECT shipment_id FROM shipment/, [{ shipment_id: SHIPMENT_ID }])
    .on(/jsonb_set\(working_values/, []) // phase 1 working values: none mutable
    .on(/jsonb_set\(snapshot/, []) // filled per-test via rowCount from rows
    .on(/UPDATE gst_invoice/, [])
    .on(/UPDATE ndr_action/, [])
    .on(/SELECT document_id, object_key FROM document/, [
      { document_id: 'd1', object_key: `shops/${SHOP_ID}/labels/l1.pdf` },
    ])
    .on(/UPDATE document/, []);
}

describe('FullRedactionService.redactCustomerFull (customers/redact, §5.5)', () => {
  it('captures the customer identity BEFORE phase 1 nulls the snapshot', async () => {
    const pool = customerPool();
    const { svc } = setup(pool);
    await svc.redactCustomerFull(SHOP_ID, SCOPE);

    const captureIdx = pool.calls.findIndex((c) =>
      /SELECT order_id FROM "order"/.test(c.sql),
    );
    const phase1Idx = pool.calls.findIndex((c) => /UPDATE "order"/.test(c.sql));
    expect(captureIdx).toBeGreaterThanOrEqual(0);
    expect(phase1Idx).toBeGreaterThan(captureIdx);
    // Same filter semantics as phase 1: GIDs + email + phone.
    expect(pool.calls[captureIdx]?.params.slice(1)).toEqual([
      ['gid://shopify/Order/555000111'],
      'buyer@example.in',
      '9876543210',
    ]);
  });

  it('pseudonymizes the frozen snapshot recipient — the §5.5 exception to INV-10', async () => {
    const pool = customerPool();
    const { svc } = setup(pool);
    await svc.redactCustomerFull(SHOP_ID, SCOPE);

    const snap = pool.matching(/jsonb_set\(snapshot/)[0];
    expect(snap?.sql).toContain("jsonb_set(snapshot, '{recipient}', 'null'::jsonb)");
    expect(snap?.sql).toContain("snapshot -> 'recipient' <> 'null'::jsonb"); // never regresses
    expect(snap?.params).toEqual([SHOP_ID, [ORDER_ID]]); // INV-1 shop scope
  });

  it('strips gst_invoice buyer PII but retains the buyer GSTIN (tax fact)', async () => {
    const pool = customerPool();
    const { svc } = setup(pool);
    await svc.redactCustomerFull(SHOP_ID, SCOPE);

    const gst = pool.matching(/UPDATE gst_invoice/)[0];
    expect(gst?.sql).toContain("'legalName', NULL");
    expect(gst?.sql).toContain("'gstin', buyer_snapshot -> 'gstin'");
    expect(gst?.sql).toContain("buyer_snapshot ->> 'legalName' IS NOT NULL"); // replay no-op
  });

  it('strips ADD-27 buyer address corrections from ndr_action payloads', async () => {
    const pool = customerPool();
    const { svc } = setup(pool);
    await svc.redactCustomerFull(SHOP_ID, SCOPE);

    const ndr = pool.matching(/UPDATE ndr_action/)[0];
    expect(ndr?.sql).toContain("payload - 'address'");
    expect(ndr?.sql).toContain('FROM ndr_case');
    expect(ndr?.params).toEqual([SHOP_ID, [SHIPMENT_ID]]);
  });

  it('deletes label objects and tombstones their document rows', async () => {
    const pool = customerPool();
    const { svc, objects } = setup(pool);
    const evidence = await svc.redactCustomerFull(SHOP_ID, SCOPE);

    expect(objects.delete).toHaveBeenCalledWith(`shops/${SHOP_ID}/labels/l1.pdf`);
    const tombstone = pool.matching(/UPDATE document/)[0];
    expect(tombstone?.sql).toContain('object_key = $2 || document_id::text');
    expect(tombstone?.params[1]).toBe(REDACTED_KEY_PREFIX);
    expect(evidence.objectsDeleted).toBe(1);
    expect(evidence.documentsTombstoned).toBe(0); // MockTxPool rowCount = rows
  });

  it('records §12 deletion evidence: scope + counts per store, never PII', async () => {
    const pool = customerPool();
    const { svc, audit } = setup(pool);
    const evidence = await svc.redactCustomerFull(SHOP_ID, SCOPE);

    const full = audit.entries.find(
      (e) => (e as { action: string }).action === 'PRIVACY_REDACT_CUSTOMER_FULL',
    ) as { after: Record<string, unknown> } | undefined;
    expect(full).toBeDefined();
    expect(full!.after).toMatchObject({
      scope: 'customer',
      ordersRedacted: 1,
      objectsDeleted: 1,
    });
    expect(full!.after.verifiedNoAction).toEqual(
      expect.arrayContaining([expect.stringContaining('search indexes')]),
    );
    // No buyer PII anywhere in the audit trail (§5.7 control 4, §12).
    expect(JSON.stringify(audit.entries)).not.toContain('buyer@example.in');
    expect(JSON.stringify(audit.entries)).not.toContain('Asha');
    expect(evidence.cacheKeysEvicted).toBe(0); // verified no-op for customer scope
  });

  it('completeness: after redaction no touched table can return the customer PII', async () => {
    // Every UPDATE the sweep issues must either NULL the PII column, strip
    // the PII key, or tombstone the pointer — assert each store's statement
    // matches its erasure shape, and that all are shop-scoped (INV-1).
    const pool = customerPool();
    const { svc } = setup(pool);
    await svc.redactCustomerFull(SHOP_ID, SCOPE);

    const updates = pool.matching(/^UPDATE|UPDATE/);
    const erasureShapes: Array<[RegExp, RegExp]> = [
      [/UPDATE "order"/, /recipient_snapshot = NULL/],
      [/jsonb_set\(working_values/, /\{recipient\}', 'null'::jsonb/],
      [/jsonb_set\(snapshot/, /\{recipient\}', 'null'::jsonb/],
      [/UPDATE gst_invoice/, /'legalName', NULL/],
      [/UPDATE ndr_action/, /payload - 'address'/],
      [/UPDATE document/, /object_key = \$2 \|\| document_id::text/],
    ];
    for (const [find, shape] of erasureShapes) {
      const stmt = updates.find((c) => find.test(c.sql));
      expect(stmt, `statement matching ${find}`).toBeDefined();
      expect(stmt!.sql).toMatch(shape);
      expect(stmt!.params[0]).toBe(SHOP_ID);
    }
    // message_log untouched (recipient_ref is a salted hash — verified) and
    // rollup_hourly_stats untouched (no PII — verified).
    expect(pool.matching(/message_log/).filter((c) => /UPDATE|DELETE/.test(c.sql)))
      .toHaveLength(0);
    expect(pool.matching(/rollup_hourly_stats/)).toHaveLength(0);
  });

  it('replay is a no-op: already-redacted rows match nothing', async () => {
    const pool = new MockTxPool()
      .on(/SELECT order_id FROM "order"/, [])
      .on(/UPDATE "order"/, []); // phase 1: nothing left to redact
    const { svc, objects, audit } = setup(pool);
    const evidence = await svc.redactCustomerFull(SHOP_ID, SCOPE);

    expect(evidence.ordersRedacted).toBe(0);
    expect(evidence.snapshotsPseudonymized).toBe(0);
    expect(evidence.objectsDeleted).toBe(0);
    expect(objects.delete).not.toHaveBeenCalled();
    expect(pool.matching(/UPDATE shipment/)).toHaveLength(0);
    // The request itself is still evidenced.
    expect(
      audit.entries.some(
        (e) => (e as { action: string }).action === 'PRIVACY_REDACT_CUSTOMER_FULL',
      ),
    ).toBe(true);
  });
});

describe('FullRedactionService.redactShopFull (shop/redact, §5.5)', () => {
  function shopPool(redis: ReturnType<typeof mockRedis>) {
    redis.scan.mockResolvedValue([
      '0',
      [`track:thr:ip:${SHOP_ID}:h1`, `notif:digest:${SHOP_ID}:ndr`],
    ]);
    redis.del.mockResolvedValue(2);
    return new MockTxPool()
      .on(/UPDATE "order"/, [{ order_id: ORDER_ID }]) // phase 1
      .on(/SELECT shipment_id FROM shipment/, [{ shipment_id: SHIPMENT_ID }])
      .on(/SELECT order_id FROM "order"/, [{ order_id: ORDER_ID }])
      .on(/jsonb_set\(working_values/, [])
      .on(/jsonb_set\(snapshot/, [])
      .on(/UPDATE gst_invoice/, [])
      .on(/UPDATE ndr_action/, [])
      .on(/SELECT document_id, object_key FROM document/, [
        { document_id: 'd1', object_key: `shops/${SHOP_ID}/labels/l1.pdf` },
        { document_id: 'd2', object_key: `shops/${SHOP_ID}/reports/r9.csv` },
      ])
      .on(/UPDATE document/, []);
  }

  it('sweeps every store shop-wide: documents incl. report CSVs, caches, all track tokens', async () => {
    const redis = mockRedis();
    const pool = shopPool(redis);
    const { svc, objects, trackTokens, audit } = setup(pool, { redis });
    const evidence = await svc.redactShopFull(SHOP_ID);

    // Shop-scope document sweep has NO shipment filter — report CSVs covered.
    const docSelect = pool.matching(/SELECT document_id, object_key FROM document/)[0];
    expect(docSelect?.sql).not.toContain('shipment_id = ANY');
    expect(objects.delete).toHaveBeenCalledWith(`shops/${SHOP_ID}/labels/l1.pdf`);
    expect(objects.delete).toHaveBeenCalledWith(`shops/${SHOP_ID}/reports/r9.csv`);

    // Shop-scoped cache patterns evicted via SCAN+DEL.
    expect(redis.scan).toHaveBeenCalled();
    const patterns = redis.scan.mock.calls.map((c) => c[2]);
    expect(patterns).toContain(`track:thr:ip:${SHOP_ID}:*`);
    expect(patterns).toContain(`notif:digest:${SHOP_ID}:*`);
    expect(redis.del).toHaveBeenCalled();

    // Belt-and-braces token revocation on top of phase 1's per-shipment one.
    expect(trackTokens.revokeAllForShop).toHaveBeenCalledWith(SHOP_ID);

    expect(evidence.scope).toBe('shop');
    expect(evidence.cacheKeysEvicted).toBeGreaterThan(0);
    expect(evidence.trackTokensRevoked).toBe(2);

    const full = audit.entries.find(
      (e) => (e as { action: string }).action === 'PRIVACY_REDACT_SHOP_FULL',
    ) as { after: Record<string, unknown> } | undefined;
    expect(full).toBeDefined();
    expect(JSON.stringify(audit.entries)).not.toContain('buyer@example.in');
  });
});

describe('FullRedactionService.produceFullDataRequest (customers/data_request, §5.5)', () => {
  function dataPool() {
    return new MockTxPool()
      .on(/SELECT order_id FROM "order"/, [{ order_id: ORDER_ID }])
      .on(/SELECT shipment_id FROM shipment/, [{ shipment_id: SHIPMENT_ID }])
      .on(/SELECT order_id, shopify_order_gid/, [
        {
          order_id: ORDER_ID,
          shopify_order_gid: 'gid://shopify/Order/555000111',
          shopify_order_number: '1042',
          created_at_shopify: '2026-07-20T04:45:00Z',
          recipient_snapshot: validRecipient(),
        },
      ])
      .on(/awb_raw, booking_state/, [
        {
          shipment_id: SHIPMENT_ID,
          order_id: ORDER_ID,
          awb_raw: 'AWB123',
          booking_state: 'BOOKED',
          movement_state: 'IN_TRANSIT',
          recipient: validRecipient(),
          booked_at: '2026-07-21T10:00:00Z',
          delivered_at: null,
        },
      ])
      .on(/FROM tracking_event/, [
        {
          shipment_id: SHIPMENT_ID,
          carrier_event_status: 'IN_TRANSIT',
          raw_status: 'In transit',
          occurred_at: '2026-07-22T08:00:00Z',
          location_text: 'Bengaluru',
        },
      ])
      .on(/FROM message_log/, [
        {
          event: 'shipment.shipped',
          channel: 'EMAIL',
          state: 'SENT',
          shipment_id: SHIPMENT_ID,
          queued_at: '2026-07-21T10:01:00Z',
          sent_at: '2026-07-21T10:01:02Z',
          delivered_at: null,
        },
      ])
      .on(/FROM ticket/, [
        {
          ticket_id: 't1',
          number: 'TKT-7',
          category: 'COURIER_ISSUE',
          state: 'OPEN',
          subject: 'Where is my parcel?',
          created_at: '2026-07-23T09:00:00Z',
        },
      ]);
  }

  it('assembles the FULL record: orders + shipments + tracking + messages + tickets', async () => {
    const pool = dataPool();
    const { svc } = setup(pool);
    const record = await svc.produceFullDataRequest(SHOP_ID, SCOPE);

    expect(record.orders).toHaveLength(1);
    expect(record.shipments).toHaveLength(1);
    expect(record.trackingEvents).toHaveLength(1);
    expect(record.messages).toHaveLength(1);
    expect(record.tickets).toHaveLength(1);
    expect(record.shipments[0]?.awb).toBe('AWB123');
    expect(record.tickets[0]?.number).toBe('TKT-7');
    // Every assembly query is shop-scoped (INV-1).
    for (const call of pool.calls) {
      expect(call.params[0]).toBe(SHOP_ID);
    }
  });

  it('delivers via the notifications dispatcher; audit carries counts only', async () => {
    const pool = dataPool();
    const { svc, dispatcher, audit } = setup(pool);
    const record = await svc.produceFullDataRequest(SHOP_ID, SCOPE);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const sent = dispatcher.dispatch.mock.calls[0]?.[0] as unknown as {
      channel: string;
      to: string;
      event: string;
      body: string;
    };
    expect(sent.channel).toBe('EMAIL');
    expect(sent.to).toBe('buyer@example.in'); // addresses the send only
    expect(sent.event).toBe('privacy.data_request');
    expect(JSON.parse(sent.body)).toMatchObject({
      orders: [{ orderId: ORDER_ID }],
    });

    const entry = audit.entries.find(
      (e) => (e as { action: string }).action === 'PRIVACY_DATA_REQUEST_FULL',
    ) as { after: Record<string, unknown> } | undefined;
    expect(entry?.after).toMatchObject({
      scope: 'customer',
      orderCount: 1,
      shipmentCount: 1,
      trackingEventCount: 1,
      messageCount: 1,
      ticketCount: 1,
    });
    // The PII record itself is never audited or logged (§12, §5.7 control 4).
    expect(JSON.stringify(audit.entries)).not.toContain('Asha');
    expect(JSON.stringify(audit.entries)).not.toContain('buyer@example.in');
    expect(record.orders[0]?.recipientSnapshot).toMatchObject({
      name: 'Asha Verma',
    });
  });

  it('INV-21: a delivery failure never gates — record still returned', async () => {
    const pool = dataPool();
    const { svc, dispatcher } = setup(pool);
    dispatcher.dispatch.mockRejectedValue(new Error('provider down'));
    const record = await svc.produceFullDataRequest(SHOP_ID, SCOPE);
    expect(record.orders).toHaveLength(1);
  });
});
