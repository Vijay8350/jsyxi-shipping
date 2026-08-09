import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackPageDataService } from '../../src/modules/track-page/track-page-data.service';
import {
  TRACK_PAGE_CONFIG_DEFAULTS,
  TrackPageConfigView,
} from '../../src/modules/track-page/track-page.types';
import { SHOP, SNAPSHOT, shipmentRow } from './helpers';

function config(overrides: Partial<TrackPageConfigView> = {}): TrackPageConfigView {
  return { shopId: SHOP, version: 1, ...TRACK_PAGE_CONFIG_DEFAULTS, ...overrides };
}

const TIMELINE = [
  {
    status: 'IN_TRANSIT',
    rawStatus: 'In transit to hub',
    occurredAt: '2026-07-30T10:00:00.000Z',
    // Courier event locations are legitimately part of the timeline; keep
    // them distinct from the recipient address so the denylist is meaningful.
    locationText: 'Hub 12',
    reasonText: null,
  },
  {
    status: 'PICKED_UP' as never,
    rawStatus: 'Picked up',
    occurredAt: '2026-07-29T18:00:00.000Z',
    locationText: 'Mumbai',
    reasonText: null,
  },
];

describe('TrackPageDataService — page data builder (§9.16)', () => {
  let query: ReturnType<typeof vi.fn>;
  let service: TrackPageDataService;

  beforeEach(() => {
    query = vi.fn();
    service = new TrackPageDataService({ query } as unknown as Pool);
  });

  it('exposes status, timeline, EDD, courier and items under the defaults', () => {
    const data = service.buildShipmentData(shipmentRow() as never, TIMELINE, config());

    expect(data.status).toBe('IN_TRANSIT');
    expect(data.awb).toBe('AWB 1234-X');
    expect(data.isTest).toBe(false);
    expect(data.courierName).toBe('Delhivery'); // S-35 on
    expect(data.edd).toEqual({
      from: '2026-08-03',
      to: '2026-08-05',
      source: 'RATE_CARD_SLA',
    });
    expect(data.items).toEqual([
      { title: 'Cotton Kurta', variant: 'M / Blue', quantity: 2, thumbnail: null },
      { title: 'Silk Stole', variant: null, quantity: 1, thumbnail: null },
    ]);
    expect(data.timeline).toHaveLength(2);
  });

  it('S-35 off hides the courier name', () => {
    const data = service.buildShipmentData(
      shipmentRow() as never,
      TIMELINE,
      config({ showCourierName: false }),
    );
    expect(data.courierName).toBeNull();
  });

  it('S-36 off hides the item summary entirely', () => {
    const data = service.buildShipmentData(
      shipmentRow() as never,
      TIMELINE,
      config({ showItemSummary: false }),
    );
    expect(data.items).toBeNull();
  });

  it('renders from the timeline when the recipient is redacted (§5.5)', () => {
    const redacted = shipmentRow({
      snapshot: { ...SNAPSHOT, recipient: null },
    });
    const data = service.buildShipmentData(redacted as never, TIMELINE, config());
    expect(data.status).toBe('IN_TRANSIT');
    expect(data.timeline).toHaveLength(2);
    expect(data.items).toHaveLength(2);
  });

  it('renders without a snapshot quote (EDD null) and without a snapshot at all', () => {
    const noQuote = shipmentRow({ snapshot: { ...SNAPSHOT, expectedQuote: null } });
    expect(
      service.buildShipmentData(noQuote as never, TIMELINE, config()).edd,
    ).toBeNull();

    const noSnapshot = shipmentRow({ snapshot: null });
    const data = service.buildShipmentData(noSnapshot as never, [], config());
    expect(data.edd).toBeNull();
    expect(data.items).toEqual([]);
    expect(data.timeline).toEqual([]);
  });

  it('DENYLIST: the serialized page data can never carry address, contact, credential or total fields (§9.16)', () => {
    const view = {
      ok: true,
      branding: service.branding(config()),
      shipment: service.buildShipmentData(shipmentRow() as never, TIMELINE, config()),
    };
    const json = JSON.stringify(view);

    // Recipient PII values from the snapshot must not leak in any form.
    for (const pii of [
      'Riya Sharma',
      'MG Road',
      'Indiranagar',
      'Bengaluru', // city is part of the address block
      'Karnataka',
      '560001',
      '98765 43210',
      '9876543210',
      'riya@example.com',
    ]) {
      expect(json).not.toContain(pii);
    }
    // Order totals / money must not leak (§9.16: never order totals).
    expect(json).not.toContain('450.00');
    expect(json).not.toContain('499.00');
    expect(json).not.toContain('unitPrice');
    // No denylisted keys at all.
    for (const key of [
      'recipient',
      'address',
      'phone',
      'email',
      'pincode',
      'total',
      'amount',
      'collectible',
      'credential',
    ]) {
      expect(json.toLowerCase()).not.toContain(`"${key}"`);
    }
  });

  it('loadTimeline reads tracking_event shop-scoped, newest first (INV-1)', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          carrier_event_status: 'OUT_FOR_DELIVERY',
          raw_status: 'OFD',
          occurred_at: new Date('2026-07-31T08:00:00.000Z'),
          location_text: 'Bengaluru',
          reason_text: null,
        },
        {
          carrier_event_status: null, // unmapped status (§3.6)
          raw_status: 'weird-courier-code',
          occurred_at: '2026-07-30T08:00:00.000Z',
          location_text: null,
          reason_text: 'Customer unavailable',
        },
      ],
    });

    const timeline = await service.loadTimeline(SHOP, 'ship-1');

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM tracking_event');
    expect(sql).toContain('shop_id = $1 AND shipment_id = $2');
    expect(sql).toContain('ORDER BY occurred_at DESC');
    expect(params).toEqual([SHOP, 'ship-1']);
    expect(timeline[0].occurredAt).toBe('2026-07-31T08:00:00.000Z');
    expect(timeline[1].status).toBeNull();
    expect(timeline[1].rawStatus).toBe('weird-courier-code');
    expect(timeline[1].reasonText).toBe('Customer unavailable');
  });
});
