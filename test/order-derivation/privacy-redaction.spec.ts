import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { PrivacyRedactionService } from '../../src/modules/order-derivation/privacy-redaction.service';
import {
  CustomersDataRequestHandler,
  CustomersRedactHandler,
  ShopRedactHandler,
} from '../../src/modules/order-derivation/handlers/gdpr-webhook.handlers';
import { ShopifyWebhookDispatcher } from '../../src/modules/shopify/webhook-dispatcher.service';
import { MockTxPool, mockAudit, ORDER_ID, SHOP_ID } from '../order-sync/helpers';
import { validRecipient } from './helpers';

/** §5.5 privacy redaction: PII removed, deletion evidence audited with
 *  scope + counts, never the PII, and redaction never regresses. */

function makeService(pool: MockTxPool) {
  const audit = mockAudit();
  // §5.5: redaction revokes buyer track access — stubbed token service.
  const trackTokens = {
    revokeForShipment: vi.fn(async () => 1),
    revokeAllForShop: vi.fn(async () => 1),
  };
  const svc = new PrivacyRedactionService(
    pool as unknown as Pool,
    audit as unknown as AuditService,
    trackTokens as never,
  );
  return { svc, audit, trackTokens };
}

const SCOPE = { shopifyOrderIds: [555000111], email: 'buyer@example.in', phone: null };

describe('PrivacyRedactionService.redactCustomer (customers/redact, §5.5)', () => {
  it('nulls recipient_snapshot + mutable working-values recipients, audits counts only', async () => {
    const pool = new MockTxPool()
      .on(/UPDATE "order"/, [{ order_id: ORDER_ID }])
      .on(/UPDATE shipment/, [{ shipment_id: 's1' }]);
    const { svc, audit } = makeService(pool);
    const result = await svc.redactCustomer(SHOP_ID, SCOPE);

    expect(result).toEqual({ ordersRedacted: 1, shipmentsTouched: 1 });

    const orderUpdate = pool.matching(/UPDATE "order"/)[0];
    expect(orderUpdate?.sql).toContain('recipient_snapshot = NULL');
    expect(orderUpdate?.sql).toContain('recipient_snapshot IS NOT NULL'); // never regresses
    expect(orderUpdate?.params[0]).toBe(SHOP_ID); // INV-1 shop scope
    expect(orderUpdate?.params[1]).toEqual(['gid://shopify/Order/555000111']);

    const shipUpdate = pool.matching(/UPDATE shipment/)[0];
    expect(shipUpdate?.sql).toContain("jsonb_set(working_values, '{recipient}'");
    // Frozen snapshots are INV-10 immutable — only mutable rows are touched.
    expect(shipUpdate?.sql).toContain("booking_state IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT')");

    // §12: deletion evidence — scope + counts, never the PII.
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'PRIVACY_REDACT_CUSTOMER',
      actorKind: 'SYSTEM',
      after: { scope: 'customer', ordersRedacted: 1, shipmentsTouched: 1 },
    });
    expect(JSON.stringify(audit.entries)).not.toContain('buyer@example.in');
  });

  it('replay is a no-op: already-redacted rows do not match, nothing is restored', async () => {
    const pool = new MockTxPool().on(/UPDATE "order"/, []);
    const { svc, audit } = makeService(pool);
    const result = await svc.redactCustomer(SHOP_ID, SCOPE);
    expect(result).toEqual({ ordersRedacted: 0, shipmentsTouched: 0 });
    expect(pool.matching(/UPDATE shipment/)).toHaveLength(0); // no orders → no cascade
    expect(audit.entries).toHaveLength(1); // the request itself is still evidenced
  });
});

describe('PrivacyRedactionService.redactShop (shop/redact, §5.5)', () => {
  it('redacts every order of the shop — no customer filter', async () => {
    const pool = new MockTxPool()
      .on(/UPDATE "order"/, [{ order_id: 'o1' }, { order_id: 'o2' }])
      .on(/UPDATE shipment/, [{ shipment_id: 's1' }, { shipment_id: 's2' }, { shipment_id: 's3' }]);
    const { svc, audit } = makeService(pool);
    const result = await svc.redactShop(SHOP_ID);

    expect(result).toEqual({ ordersRedacted: 2, shipmentsTouched: 3 });
    const orderUpdate = pool.matching(/UPDATE "order"/)[0];
    expect(orderUpdate?.params).toEqual([SHOP_ID]); // whole shop, no customer criteria
    expect(audit.entries[0]).toMatchObject({
      action: 'PRIVACY_REDACT_SHOP',
      after: { scope: 'shop', ordersRedacted: 2, shipmentsTouched: 3 },
    });
  });
});

describe('PrivacyRedactionService.produceDataRequest (customers/data_request, §5.5, INV-21)', () => {
  it('produces the held record and audits the request with counts only', async () => {
    const pool = new MockTxPool().on(/FROM "order"/, [
      {
        order_id: ORDER_ID,
        shopify_order_gid: 'gid://shopify/Order/555000111',
        shopify_order_number: '1042',
        recipient_snapshot: validRecipient(),
      },
    ]);
    const { svc, audit } = makeService(pool);
    const record = await svc.produceDataRequest(SHOP_ID, {
      shopifyOrderIds: [555000111],
      email: 'buyer@example.in',
      phone: null,
    });

    // The record of what is held: order ids + the snapshot fields.
    expect(record.orders).toHaveLength(1);
    expect(record.orders[0]?.orderId).toBe(ORDER_ID);
    expect(record.orders[0]?.recipientSnapshot?.name).toBe('Asha Verma');

    // The request is recorded (§12); the PII record itself is NOT logged.
    expect(audit.entries[0]).toMatchObject({
      action: 'PRIVACY_DATA_REQUEST',
      after: { scope: 'customer', orderCount: 1 },
    });
    expect(JSON.stringify(audit.entries)).not.toContain('Asha');
  });
});

describe('GDPR webhook handlers (§8.1 topics)', () => {
  function setup() {
    const dispatcher = new ShopifyWebhookDispatcher();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const redaction = {
      redactCustomerFull: (...args: unknown[]) => {
        calls.push({ method: 'redactCustomerFull', args });
        return Promise.resolve({ ordersRedacted: 0, shipmentsTouched: 0 });
      },
      redactShopFull: (...args: unknown[]) => {
        calls.push({ method: 'redactShopFull', args });
        return Promise.resolve({ ordersRedacted: 0, shipmentsTouched: 0 });
      },
      produceFullDataRequest: (...args: unknown[]) => {
        calls.push({ method: 'produceFullDataRequest', args });
        return Promise.resolve({ orders: [] });
      },
    };
    const handlers = [
      new CustomersRedactHandler(dispatcher, redaction as never),
      new ShopRedactHandler(dispatcher, redaction as never),
      new CustomersDataRequestHandler(dispatcher, redaction as never),
    ];
    handlers.forEach((h) => h.onModuleInit());
    return { dispatcher, calls };
  }

  const message = (topic: string, payload: unknown) => ({
    inboxId: 'i1',
    shopId: SHOP_ID,
    topic,
    externalId: 'e1',
    payload,
  });

  it('registers all three §5.5 topics and routes each to its service method', async () => {
    const { dispatcher, calls } = setup();

    await dispatcher.dispatch(
      message('customers/redact', {
        customer: { id: 77, email: 'buyer@example.in', phone: null },
        orders_to_redact: [555000111],
      }),
    );
    await dispatcher.dispatch(message('shop/redact', {}));
    await dispatcher.dispatch(
      message('customers/data_request', {
        customer: { id: 77, email: 'buyer@example.in' },
        orders_requested: [555000111],
      }),
    );

    expect(calls.map((c) => c.method)).toEqual([
      'redactCustomerFull',
      'redactShopFull',
      'produceFullDataRequest',
    ]);
    expect(calls[0]?.args).toEqual([
      SHOP_ID,
      { shopifyOrderIds: [555000111], email: 'buyer@example.in', phone: null },
    ]);
    expect(calls[1]?.args).toEqual([SHOP_ID]);
  });
});
