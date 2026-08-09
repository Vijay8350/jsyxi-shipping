import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AuditService } from "../../src/audit/audit.service";
import { WebhookPayloadsService } from '../../src/modules/tracking/webhook-payloads.service';
import { TrackingIngestService } from '../../src/modules/tracking/tracking-ingest.service';
import { MovementReducerService } from '../../src/modules/tracking/movement-reducer.service';
import { maskPayload } from '../../src/modules/tracking/tracking.util';
import type { SyncBackService } from '../../src/modules/sync-back/sync-back.service';
import type { TrackingSeams } from '../../src/modules/tracking/tracking-seams';
import type { ProcessResult } from '../../src/modules/tracking/tracking.types';
import {
  COURIER_ACCOUNT_ID,
  EVENT_ID,
  FnPool,
  MEMBER_ID,
  RAW_EVENT_ID,
  SHIPMENT_ID,
  SHOP_ID,
  mockAudit,
  rawEventRow,
  shipmentRow,
  webhookPayload,
} from './helpers';

/**
 * ADD-18 webhook management surface: the masked last-20-payloads viewer
 * (INV-18, §5.7 control 4) and the merchant-side idempotent, audited replay.
 */

const ACCOUNT_CHECK = /SELECT courier_account_id FROM courier_account/;
const LIST_SQL = /SELECT raw_event_id, received_at, source, parse_result/;
const REPLAY_FIND = /SELECT raw_event_id FROM tracking_event_raw\s+WHERE shop_id/;

function rawPayloadRow(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    raw_event_id: RAW_EVENT_ID,
    received_at: '2026-08-01T10:00:00.000Z',
    source: 'WEBHOOK',
    parse_result: 'ACCEPTED',
    signature_valid: true,
    awb_normalized: 'DL12345',
    payload,
    ...overrides,
  };
}

describe('maskPayload (INV-18, §5.7 control 4)', () => {
  it('masks phone, email, name and address fields; leaves operational fields', () => {
    const masked = maskPayload({
      waybill: 'DL12345',
      status: 'In Transit',
      phone: '9876543210',
      alternate_mobile: '+91 98765 43210',
      email: 'buyer@example.in',
      recipient_name: 'Asha Verma',
      address: '12, MG Road, Bengaluru',
      pincode: '560001',
      nested: { customer_email: 'deep@example.in', attempts: 2 },
      list: [{ phone: '9000000001' }],
    }) as Record<string, unknown>;

    expect(masked.waybill).toBe('DL12345');
    expect(masked.status).toBe('In Transit');
    expect(masked.phone).toBe('98******10');
    expect(masked.alternate_mobile).toBe('91********10');
    expect(masked.email).toBe('b***@e***');
    expect(masked.recipient_name).toBe('[masked]');
    expect(masked.address).toBe('[masked]');
    expect(masked.pincode).toBe('560001'); // not identifying on its own
    const nested = masked.nested as Record<string, unknown>;
    expect(nested.customer_email).toBe('d***@e***');
    expect(nested.attempts).toBe(2);
    expect((masked.list as Array<Record<string, unknown>>)[0].phone).toBe('90******01');
  });

  it('never throws on odd shapes', () => {
    expect(maskPayload(null)).toBeNull();
    expect(maskPayload('plain')).toBe('plain');
    expect(maskPayload(42)).toBe(42);
    expect(maskPayload([1, 'two', null])).toEqual([1, 'two', null]);
  });
});

describe('WebhookPayloadsService.listPayloads (ADD-18)', () => {
  it('returns the last 20 raw payloads with parse result, masked, shop-scoped', async () => {
    const pool = new FnPool();
    pool.on(ACCOUNT_CHECK, [{ courier_account_id: COURIER_ACCOUNT_ID }]);
    pool.on(LIST_SQL, [
      rawPayloadRow({
        waybill: 'DL12345',
        status: 'Delivered',
        phone: '9876543210',
        address: '12, MG Road',
      }),
    ]);
    const audit = mockAudit();
    const service = new WebhookPayloadsService(
      pool.asPool(),
      audit as unknown as AuditService,
      {} as unknown as TrackingIngestService,
    );

    const rows = await service.listPayloads(SHOP_ID, COURIER_ACCOUNT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].parse_result).toBe('ACCEPTED');
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.phone).toBe('98******10');
    expect(payload.address).toBe('[masked]');
    expect(payload.status).toBe('Delivered');
    const call = pool.matching(LIST_SQL)[0];
    expect(call.sql).toContain('LIMIT 20');
    expect(call.params).toEqual([SHOP_ID, COURIER_ACCOUNT_ID]); // INV-1
  });

  it('rejects an account outside the caller shop (INV-1)', async () => {
    const pool = new FnPool();
    pool.on(ACCOUNT_CHECK, []); // no such account in this shop
    const service = new WebhookPayloadsService(
      pool.asPool(),
      mockAudit() as unknown as AuditService,
      {} as unknown as TrackingIngestService,
    );

    await expect(service.listPayloads(SHOP_ID, COURIER_ACCOUNT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(pool.matching(LIST_SQL)).toEqual([]);
  });
});

describe('WebhookPayloadsService.replayPayload (ADD-18 replay)', () => {
  function mkService(pool: FnPool, processResult: ProcessResult) {
    const audit = mockAudit();
    const ingest = { processRawEvent: vi.fn().mockResolvedValue(processResult) };
    const service = new WebhookPayloadsService(
      pool.asPool(),
      audit as unknown as AuditService,
      ingest as unknown as TrackingIngestService,
    );
    return { service, audit, ingest };
  }

  const replayInput = {
    shopId: SHOP_ID,
    courierAccountId: COURIER_ACCOUNT_ID,
    rawEventId: RAW_EVENT_ID,
    memberId: MEMBER_ID,
  };

  it('re-runs processRawEvent and audits the replay (§12, merchant-side)', async () => {
    const pool = new FnPool();
    pool.on(ACCOUNT_CHECK, [{ courier_account_id: COURIER_ACCOUNT_ID }]);
    pool.on(REPLAY_FIND, [{ raw_event_id: RAW_EVENT_ID }]);
    const { service, audit, ingest } = mkService(pool, {
      rawEventId: RAW_EVENT_ID,
      parseResult: 'DUPLICATE',
      shipmentId: SHIPMENT_ID,
      eventId: null,
      carrierEventStatus: 'IN_TRANSIT',
      stateChanged: false,
      reviewFlag: false,
    });

    const result = await service.replayPayload(replayInput);

    expect(result.parseResult).toBe('DUPLICATE');
    expect(ingest.processRawEvent).toHaveBeenCalledWith(RAW_EVENT_ID);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      shopId: SHOP_ID,
      actorKind: 'MEMBER',
      actorId: MEMBER_ID,
      action: 'tracking.webhook_payload.replay',
      objectType: 'tracking_event_raw',
      objectId: RAW_EVENT_ID,
    });
  });

  it('is idempotent end-to-end: replaying an accepted event is a dedupe no-op', async () => {
    // Real ingest pipeline: first pass ACCEPTED, replay hits the normalized
    // dedupe layer and changes nothing.
    const pool = new FnPool();
    pool.on(ACCOUNT_CHECK, [{ courier_account_id: COURIER_ACCOUNT_ID }]);
    pool.on(REPLAY_FIND, [{ raw_event_id: RAW_EVENT_ID }]);
    pool.on(/SELECT raw_event_id, shop_id, courier_account_id, awb_normalized/, [rawEventRow()]);
    pool.on(/FROM shipment\s+WHERE shop_id = \$1 AND awb_normalized/, [
      { shipment_id: SHIPMENT_ID, courier_account_id: COURIER_ACCOUNT_ID },
    ]);
    pool.on(/FROM courier_status_map/, [{ carrier_event_status: 'IN_TRANSIT' }]);
    let eventStored = false;
    pool.onFn(/SELECT event_id FROM tracking_event/, () =>
      eventStored
        ? { rows: [{ event_id: EVENT_ID }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    pool.onFn(/INSERT INTO tracking_event\s/, () => {
      eventStored = true;
      return { rows: [{ event_id: EVENT_ID }], rowCount: 1 };
    });
    pool.on(/SELECT shipment_id, shop_id, order_id, movement_state/, [shipmentRow()]);
    pool.on(/UPDATE shipment\s+SET movement_state/, [], 1);

    const reducer = new MovementReducerService(
      pool.asPool(),
      { enqueueFulfillmentEvent: vi.fn() } as unknown as SyncBackService,
      { onDelivered: vi.fn(), onNdr: vi.fn() } as unknown as TrackingSeams,
    );
    const ingest = new TrackingIngestService(pool.asPool(), reducer);
    const audit = mockAudit();
    const service = new WebhookPayloadsService(pool.asPool(), audit as unknown as AuditService, ingest);

    const first = await ingest.processRawEvent(RAW_EVENT_ID);
    expect(first.parseResult).toBe('ACCEPTED');
    expect(first.stateChanged).toBe(true);

    const replayed = await service.replayPayload(replayInput);
    expect(replayed.parseResult).toBe('DUPLICATE');
    expect(replayed.stateChanged).toBe(false);
    // Exactly one normalized event and one shipment write across both runs.
    expect(pool.matching(/INSERT INTO tracking_event\s/)).toHaveLength(1);
    expect(pool.matching(/UPDATE shipment\s+SET movement_state/)).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
  });

  it('refuses to replay a payload belonging to another account/shop (INV-1)', async () => {
    const pool = new FnPool();
    pool.on(ACCOUNT_CHECK, [{ courier_account_id: COURIER_ACCOUNT_ID }]);
    pool.on(REPLAY_FIND, []); // raw event not under this account
    const { service, ingest } = mkService(pool, {} as ProcessResult);

    await expect(service.replayPayload(replayInput)).rejects.toBeInstanceOf(NotFoundException);
    expect(ingest.processRawEvent).not.toHaveBeenCalled();
  });
});
