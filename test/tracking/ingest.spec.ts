import { describe, expect, it, vi } from 'vitest';
import { CourierWebhookIngestService } from '../../src/modules/tracking/courier-webhook-ingest.service';
import { TrackingIngestService } from '../../src/modules/tracking/tracking-ingest.service';
import { MovementReducerService } from '../../src/modules/tracking/movement-reducer.service';
import type { TrackingIngestQueueService } from '../../src/modules/tracking/tracking-queue';
import type { SyncBackService } from '../../src/modules/sync-back/sync-back.service';
import type { TrackingSeams } from '../../src/modules/tracking/tracking-seams';
import {
  AWB_NORMALIZED,
  COURIER_ACCOUNT_ID,
  EVENT_ID,
  FnPool,
  RAW_EVENT_ID,
  SHIPMENT_ID,
  SHOP_ID,
  fingerprintPayload,
  rawEventRow,
  shipmentRow,
  webhookPayload,
} from './helpers';

/**
 * §8.5 durable ingest + §9.7 normalization:
 * durable-before-ack ordering, both dedupe layers (provider id + canonical
 * fingerprint), signature-failure recording, unknown-AWB quarantine (INV-20),
 * unmapped status stores + flags + changes nothing (§3.6).
 */

const INSERT_RAW = /INSERT INTO tracking_event_raw/;
const RAW_DEDUPE_CHECK = /SELECT raw_event_id FROM tracking_event_raw/;
const ADVISORY_LOCK = /pg_advisory_xact_lock/;
const LOAD_RAW = /SELECT raw_event_id, shop_id, courier_account_id, awb_normalized/;
const RESOLVE_SHIPMENT = /FROM shipment\s+WHERE shop_id = \$1 AND awb_normalized/;
const MAP_STATUS = /FROM courier_status_map/;
const EVENT_DEDUPE_CHECK = /SELECT event_id FROM tracking_event/;
const INSERT_EVENT = /INSERT INTO tracking_event\s/;
const SET_PARSE = /UPDATE tracking_event_raw\s+SET parse_result/;
const TOUCH_HEALTH = /UPDATE courier_account\s+SET last_event_received_at/;
const REDUCER_LOAD = /SELECT shipment_id, shop_id, order_id, movement_state/;
const UPDATE_SHIPMENT = /UPDATE shipment\s+SET movement_state/;

function mkIngest(pool: FnPool) {
  const queue = {
    enqueued: [] as string[],
    callCountAtEnqueue: [] as number[],
    enqueueRawEvent(id: string) {
      this.enqueued.push(id);
      this.callCountAtEnqueue.push(pool.calls.length);
      return Promise.resolve();
    },
  };
  const service = new CourierWebhookIngestService(
    pool.asPool(),
    queue as unknown as TrackingIngestQueueService,
  );
  return { service, queue };
}

function mkProcessor(pool: FnPool) {
  const syncBack = { enqueueFulfillmentEvent: vi.fn().mockResolvedValue(undefined) };
  const seams = { onDelivered: vi.fn().mockResolvedValue(undefined), onNdr: vi.fn().mockResolvedValue(undefined) };
  const reducer = new MovementReducerService(
    pool.asPool(),
    syncBack as unknown as SyncBackService,
    seams as unknown as TrackingSeams,
  );
  const service = new TrackingIngestService(pool.asPool(), reducer);
  return { service, syncBack, seams };
}

describe('CourierWebhookIngestService (§8.5 durable ingest)', () => {
  it('persists the raw payload BEFORE the ack path can queue it (durable-first)', async () => {
    const pool = new FnPool();
    pool.on(INSERT_RAW, [{ raw_event_id: RAW_EVENT_ID }]);
    const { service, queue } = mkIngest(pool);

    const result = await service.ingestVerifiedWebhook({
      courierAccountId: COURIER_ACCOUNT_ID,
      courierCode: 'DELHIVERY',
      shopId: SHOP_ID,
      rawBody: Buffer.from(JSON.stringify(webhookPayload())),
      signatureValid: true,
    });

    expect(result).toEqual({ rawEventId: RAW_EVENT_ID, parseResult: 'PENDING', queued: true });
    const insertIdx = pool.firstIndexOf(INSERT_RAW);
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    // The queue job is only ever added after the durable insert landed.
    expect(queue.enqueued).toEqual([RAW_EVENT_ID]);
    expect(queue.callCountAtEnqueue[0]).toBeGreaterThan(insertIdx);
    // Dedupe guard: advisory lock precedes the existence check precedes insert.
    expect(pool.firstIndexOf(ADVISORY_LOCK)).toBeLessThan(pool.firstIndexOf(RAW_DEDUPE_CHECK));
    expect(pool.firstIndexOf(RAW_DEDUPE_CHECK)).toBeLessThan(insertIdx);
    // source WEBHOOK, signature_valid true, provider-id dedupe (§8.5).
    const insert = pool.matching(INSERT_RAW)[0];
    expect(insert.params[4]).toBe('WEBHOOK');
    expect(insert.params[5]).toBe(true);
    expect(String(insert.params[6])).toMatch(/^pid:/);
    expect(insert.params[7]).toBe('PENDING');
  });

  it('dedupes on provider event id: a repeat lands DUPLICATE and is never queued', async () => {
    const pool = new FnPool();
    pool.on(RAW_DEDUPE_CHECK, [{ raw_event_id: 'existing' }]);
    pool.on(INSERT_RAW, [{ raw_event_id: RAW_EVENT_ID }]);
    const { service, queue } = mkIngest(pool);

    const result = await service.ingestVerifiedWebhook({
      courierAccountId: COURIER_ACCOUNT_ID,
      courierCode: 'DELHIVERY',
      shopId: SHOP_ID,
      rawBody: Buffer.from(JSON.stringify(webhookPayload())),
      signatureValid: true,
    });

    // §8.5: a repeat is a no-op — the ack still succeeds, nothing processed.
    expect(result.parseResult).toBe('DUPLICATE');
    expect(result.queued).toBe(false);
    expect(queue.enqueued).toEqual([]);
    expect(pool.matching(INSERT_RAW)[0].params[7]).toBe('DUPLICATE');
  });

  it('falls back to the canonical fingerprint when no provider event id exists', async () => {
    const pool = new FnPool();
    pool.on(INSERT_RAW, [{ raw_event_id: RAW_EVENT_ID }]);
    const { service } = mkIngest(pool);

    await service.ingestVerifiedWebhook({
      courierAccountId: COURIER_ACCOUNT_ID,
      courierCode: 'DELHIVERY',
      shopId: SHOP_ID,
      rawBody: Buffer.from(JSON.stringify(fingerprintPayload())),
      signatureValid: true,
    });

    // Fingerprint = raw status + normalized occurred-at + location + reason.
    expect(String(pool.matching(INSERT_RAW)[0].params[6])).toMatch(/^fp:/);
  });

  it('fingerprint is stable across cosmetically different redeliveries', async () => {
    const pool = new FnPool();
    pool.on(INSERT_RAW, [{ raw_event_id: RAW_EVENT_ID }]);
    const { service } = mkIngest(pool);
    const base = fingerprintPayload();

    await service.ingestVerifiedWebhook({
      courierAccountId: COURIER_ACCOUNT_ID,
      courierCode: 'DELHIVERY',
      shopId: SHOP_ID,
      rawBody: Buffer.from(JSON.stringify(base)),
      signatureValid: true,
    });
    // Same event, whitespace/case noise in AWB and status.
    await service.ingestVerifiedWebhook({
      courierAccountId: COURIER_ACCOUNT_ID,
      courierCode: 'DELHIVERY',
      shopId: SHOP_ID,
      rawBody: Buffer.from(
        JSON.stringify(fingerprintPayload({ waybill: ' DL 123-45 ', status: 'in   transit' })),
      ),
      signatureValid: true,
    });

    const hashes = pool.matching(INSERT_RAW).map((c) => c.params[6]);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('records signature failures as SIGNATURE_FAILURE rows and never queues them', async () => {
    const pool = new FnPool();
    pool.on(INSERT_RAW, [{ raw_event_id: RAW_EVENT_ID }]);
    const { service, queue } = mkIngest(pool);

    const result = await service.ingestVerifiedWebhook({
      courierAccountId: COURIER_ACCOUNT_ID,
      courierCode: 'DELHIVERY',
      shopId: SHOP_ID,
      rawBody: Buffer.from(JSON.stringify(webhookPayload())),
      signatureValid: false,
    });

    expect(result.parseResult).toBe('SIGNATURE_FAILURE');
    expect(result.queued).toBe(false);
    expect(queue.enqueued).toEqual([]);
    const insert = pool.matching(INSERT_RAW)[0];
    expect(insert.params[5]).toBe(false); // signature_valid
    expect(insert.params[7]).toBe('SIGNATURE_FAILURE');
    expect(pool.matching(ADVISORY_LOCK)).toEqual([]); // no dedupe work at all
  });

  it('is tolerant of unparseable bodies: stored, deduped by body hash, still acked', async () => {
    const pool = new FnPool();
    pool.on(INSERT_RAW, [{ raw_event_id: RAW_EVENT_ID }]);
    const { service } = mkIngest(pool);

    const result = await service.ingestVerifiedWebhook({
      courierAccountId: COURIER_ACCOUNT_ID,
      courierCode: 'DELHIVERY',
      shopId: SHOP_ID,
      rawBody: Buffer.from('not json at all'),
      signatureValid: true,
    });

    expect(result.queued).toBe(true);
    expect(String(pool.matching(INSERT_RAW)[0].params[6])).toMatch(/^body:/);
  });
});

describe('TrackingIngestService.processRawEvent (§9.7 normalization)', () => {
  it('quarantines an event whose AWB resolves to no Shipment (INV-20, never dropped)', async () => {
    const pool = new FnPool();
    pool.on(LOAD_RAW, [rawEventRow()]);
    pool.on(RESOLVE_SHIPMENT, []); // no shipment for this AWB
    const { service } = mkProcessor(pool);

    const result = await service.processRawEvent(RAW_EVENT_ID);

    expect(result.parseResult).toBe('AWB_QUARANTINED');
    expect(result.shipmentId).toBeNull();
    // The raw row is flagged and retained; no normalized event, no state work.
    expect(pool.matching(SET_PARSE)[0].params[1]).toBe('AWB_QUARANTINED');
    expect(pool.matching(INSERT_EVENT)).toEqual([]);
    expect(pool.matching(UPDATE_SHIPMENT)).toEqual([]);
  });

  it('quarantines an unextractable payload instead of dropping it (INV-20)', async () => {
    const pool = new FnPool();
    pool.on(LOAD_RAW, [rawEventRow({ payload: { hello: 'world' } })]);
    const { service } = mkProcessor(pool);

    const result = await service.processRawEvent(RAW_EVENT_ID);

    expect(result.parseResult).toBe('AWB_QUARANTINED');
    expect(pool.matching(INSERT_EVENT)).toEqual([]);
  });

  it('skips SIGNATURE_FAILURE rows even when replayed', async () => {
    const pool = new FnPool();
    pool.on(LOAD_RAW, [rawEventRow({ parse_result: 'SIGNATURE_FAILURE', signature_valid: false })]);
    const { service } = mkProcessor(pool);

    const result = await service.processRawEvent(RAW_EVENT_ID);

    expect(result.parseResult).toBe('SIGNATURE_FAILURE');
    expect(pool.matching(INSERT_EVENT)).toEqual([]);
  });

  it('unmapped status: stored with NULL status + review flag, changes NOTHING (§3.6)', async () => {
    const pool = new FnPool();
    pool.on(LOAD_RAW, [rawEventRow()]);
    pool.on(RESOLVE_SHIPMENT, [{ shipment_id: SHIPMENT_ID, courier_account_id: COURIER_ACCOUNT_ID }]);
    pool.on(MAP_STATUS, []); // no courier_status_map row
    pool.on(INSERT_EVENT, [{ event_id: EVENT_ID }]);
    const { service } = mkProcessor(pool);

    const result = await service.processRawEvent(RAW_EVENT_ID);

    expect(result.parseResult).toBe('UNMAPPED_STATUS');
    expect(result.carrierEventStatus).toBeNull();
    expect(result.reviewFlag).toBe(true);
    const insert = pool.matching(INSERT_EVENT)[0];
    expect(insert.params[2]).toBeNull(); // carrier_event_status NULL
    expect(insert.params[9]).toBe(true); // review_flag — the §9.13 monitor reads this
    // No reducer run: no shipment write, no fulfillment event.
    expect(pool.matching(UPDATE_SHIPMENT)).toEqual([]);
    // Health strip still advances — the account IS receiving events (§8.5).
    expect(pool.matching(TOUCH_HEALTH)).toHaveLength(1);
  });

  it('dedupes again at the normalized layer (dedupe_key): a repeat is a no-op', async () => {
    const pool = new FnPool();
    pool.on(LOAD_RAW, [rawEventRow()]);
    pool.on(RESOLVE_SHIPMENT, [{ shipment_id: SHIPMENT_ID, courier_account_id: COURIER_ACCOUNT_ID }]);
    pool.on(MAP_STATUS, [{ carrier_event_status: 'IN_TRANSIT' }]);
    pool.on(EVENT_DEDUPE_CHECK, [{ event_id: 'already-there' }]);
    const { service, syncBack } = mkProcessor(pool);

    const result = await service.processRawEvent(RAW_EVENT_ID);

    expect(result.parseResult).toBe('DUPLICATE');
    expect(pool.matching(INSERT_EVENT)).toEqual([]);
    expect(pool.matching(UPDATE_SHIPMENT)).toEqual([]);
    expect(syncBack.enqueueFulfillmentEvent).not.toHaveBeenCalled();
  });

  it('mapped event: inserts the normalized event, runs the reducer, marks ACCEPTED', async () => {
    const pool = new FnPool();
    pool.on(LOAD_RAW, [rawEventRow()]);
    pool.on(RESOLVE_SHIPMENT, [{ shipment_id: SHIPMENT_ID, courier_account_id: COURIER_ACCOUNT_ID }]);
    pool.on(MAP_STATUS, [{ carrier_event_status: 'IN_TRANSIT' }]);
    pool.on(INSERT_EVENT, [{ event_id: EVENT_ID }]);
    pool.on(REDUCER_LOAD, [shipmentRow()]);
    pool.on(UPDATE_SHIPMENT, [], 1);
    const { service, syncBack } = mkProcessor(pool);

    const result = await service.processRawEvent(RAW_EVENT_ID);

    expect(result.parseResult).toBe('ACCEPTED');
    expect(result.shipmentId).toBe(SHIPMENT_ID);
    expect(result.eventId).toBe(EVENT_ID);
    expect(result.carrierEventStatus).toBe('IN_TRANSIT');
    expect(result.stateChanged).toBe(true);
    // Normalized dedupe key uses the provider event id (§8.5 preference).
    expect(String(pool.matching(INSERT_EVENT)[0].params[8])).toBe('pid:evt-1001');
    // §8.4 fulfillment event after the state change.
    expect(syncBack.enqueueFulfillmentEvent).toHaveBeenCalledWith(SHOP_ID, SHIPMENT_ID, 'IN_TRANSIT');
    expect(pool.matching(SET_PARSE).at(-1)?.params[1]).toBe('ACCEPTED');
    expect(pool.matching(TOUCH_HEALTH)).toHaveLength(1);
  });

  it('normalizes the AWB per F-19 before resolving the shipment', async () => {
    const pool = new FnPool();
    pool.on(LOAD_RAW, [rawEventRow({ payload: webhookPayload({ waybill: ' dl 123-45 ' }) })]);
    pool.on(RESOLVE_SHIPMENT, []);
    const { service } = mkProcessor(pool);

    await service.processRawEvent(RAW_EVENT_ID);

    expect(pool.matching(RESOLVE_SHIPMENT)[0].params[1]).toBe(AWB_NORMALIZED);
  });
});
