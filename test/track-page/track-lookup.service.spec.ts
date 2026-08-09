import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saltedPiiHash } from '../../src/common/crypto';
import { CaptchaVerifier } from '../../src/modules/track-page/captcha-verifier';
import { shopPublicRef, shopRefRedisKey } from '../../src/modules/track-page/shop-ref';
import { TrackLookupDto } from '../../src/modules/track-page/track-page.dto';
import { TrackPageDataService } from '../../src/modules/track-page/track-page-data.service';
import { TrackPageConfigService } from '../../src/modules/track-page/track-page-config.service';
import { TrackLookupService } from '../../src/modules/track-page/track-lookup.service';
import {
  LOOKUP_GENERIC_ERROR,
  TRACK_PAGE_CONFIG_DEFAULTS,
} from '../../src/modules/track-page/track-page.types';
import {
  APP_URL,
  FakeRedis,
  SALT,
  SHOP,
  SHOP_B,
  SNAPSHOT,
  fakeConfig,
  shipmentRow,
} from './helpers';

const IP = '203.0.113.7';
const ipHash = saltedPiiHash(SALT, IP);
const REF = shopPublicRef(SHOP, SALT);
const REF_B = shopPublicRef(SHOP_B, SALT);

const GENERIC = { ok: false, error: LOOKUP_GENERIC_ERROR };
const THROTTLED = {
  ok: false,
  error: 'Too many attempts. Please try again later.',
};

interface Fixture {
  accountState?: string | null;
  attemptTail?: Array<{ success: boolean }>;
  awbRows?: (params: unknown[]) => Array<Record<string, unknown>>;
  orderRows?: (params: unknown[]) => Array<Record<string, unknown>>;
  timelineByShipment?: Record<string, Array<Record<string, unknown>>>;
}

function makeQuery(fixture: Fixture) {
  const inserts: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT account_state FROM shop')) {
      return {
        rows: fixture.accountState
          ? [{ account_state: fixture.accountState }]
          : [],
      };
    }
    if (sql.includes('SELECT success FROM track_lookup_attempt')) {
      return { rows: fixture.attemptTail ?? [] };
    }
    if (sql.includes('INSERT INTO track_lookup_attempt')) {
      inserts.push(params);
      return { rows: [] };
    }
    if (sql.includes('awb_normalized = $2')) {
      return { rows: fixture.awbRows ? fixture.awbRows(params) : [] };
    }
    if (sql.includes('shopify_order_number')) {
      return { rows: fixture.orderRows ? fixture.orderRows(params) : [] };
    }
    if (sql.includes('FROM tracking_event')) {
      return {
        rows: fixture.timelineByShipment?.[params[1] as string] ?? [],
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { query, inserts };
}

function dto(overrides: Partial<TrackLookupDto> = {}): TrackLookupDto {
  return {
    shopRef: REF,
    identifier: 'awb 1234-x',
    contact: '9876543210',
    ...overrides,
  };
}

describe('TrackLookupService (§9.16 path 2, S-38, §5.7 control 4)', () => {
  let redis: FakeRedis;
  let captcha: { verify: ReturnType<typeof vi.fn> };
  let pageConfig: { getForRender: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    redis = new FakeRedis();
    void redis.set(shopRefRedisKey(REF), SHOP);
    void redis.set(shopRefRedisKey(REF_B), SHOP_B);
    captcha = { verify: vi.fn().mockResolvedValue(true) };
    pageConfig = {
      getForRender: vi.fn().mockResolvedValue({
        shopId: SHOP,
        version: 1,
        ...TRACK_PAGE_CONFIG_DEFAULTS,
      }),
    };
  });

  function makeService(fixture: Fixture) {
    const { query, inserts } = makeQuery(fixture);
    const pool = { query } as unknown as Pool;
    const pageData = new TrackPageDataService(pool);
    const service = new TrackLookupService(
      pool,
      redis as never,
      fakeConfig() as never,
      captcha as unknown as CaptchaVerifier,
      pageConfig as unknown as TrackPageConfigService,
      pageData,
    );
    return { service, query, inserts };
  }

  it('lookup by AWB opens that shipment only', async () => {
    const { service, query } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [shipmentRow()],
      timelineByShipment: {
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': [
          {
            carrier_event_status: 'IN_TRANSIT',
            raw_status: 'In transit',
            occurred_at: '2026-07-30T10:00:00.000Z',
            location_text: 'Hub 12',
            reason_text: null,
          },
        ],
      },
    });

    const view = await service.lookup(dto(), IP);

    expect(view.ok).toBe(true);
    if (!view.ok) throw new Error('unreachable');
    expect(view.shipments).toHaveLength(1);
    expect(view.shipments[0].status).toBe('IN_TRANSIT');
    expect(view.shipments[0].courierName).toBe('Delhivery');
    expect(view.shipments[0].timeline).toHaveLength(1);
    expect(view.branding.buttonColour).toBe('#0F6B6B');
    // F-19 normalization before the AWB match, shop-scoped (INV-1).
    const awbCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('awb_normalized = $2'),
    );
    expect(awbCall?.[1]).toEqual([SHOP, 'AWB1234X']);
  });

  it('lookup by Order ID lists EVERY shipment on the order, each with its own timeline', async () => {
    const { service } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [],
      orderRows: () => [
        shipmentRow({ shipment_id: 'ship-1' }),
        shipmentRow({ shipment_id: 'ship-2', movement_state: 'DELIVERED' }),
      ],
      timelineByShipment: {
        'ship-1': [
          {
            carrier_event_status: 'IN_TRANSIT',
            raw_status: 'line-1',
            occurred_at: '2026-07-30T10:00:00.000Z',
            location_text: null,
            reason_text: null,
          },
        ],
        'ship-2': [
          {
            carrier_event_status: 'DELIVERED',
            raw_status: 'line-2',
            occurred_at: '2026-07-31T10:00:00.000Z',
            location_text: null,
            reason_text: null,
          },
        ],
      },
    });

    const view = await service.lookup(
      dto({ identifier: '#1001', contact: 'Riya@Example.com ' }),
      IP,
    );

    expect(view.ok).toBe(true);
    if (!view.ok) throw new Error('unreachable');
    expect(view.shipments).toHaveLength(2);
    expect(view.shipments[0].timeline[0].rawStatus).toBe('line-1');
    expect(view.shipments[1].timeline[0].rawStatus).toBe('line-2');
    expect(view.shipments[1].status).toBe('DELIVERED');
  });

  it('returns ONE generic failure for wrong-shop, wrong-contact and unknown-identifier (no oracle)', async () => {
    // Wrong shop: the order exists on SHOP_B, the lookup runs against SHOP —
    // shop-scoped queries return nothing (INV-1).
    const wrongShop = await makeService({
      accountState: 'ACTIVE',
      awbRows: (params) => (params[0] === SHOP_B ? [shipmentRow()] : []),
      orderRows: () => [],
    }).service.lookup(dto(), IP);

    // Wrong contact: identifier matches but the phone does not.
    const wrongContact = await makeService({
      accountState: 'ACTIVE',
      awbRows: () => [shipmentRow()],
    }).service.lookup(dto({ contact: '9000000000' }), IP);

    // Unknown identifier: nothing matches anywhere.
    const unknownIdentifier = await makeService({
      accountState: 'ACTIVE',
      awbRows: () => [],
      orderRows: () => [],
    }).service.lookup(dto({ identifier: 'NO-SUCH-THING' }), IP);

    expect(wrongShop).toEqual(GENERIC);
    expect(wrongContact).toEqual(GENERIC);
    expect(unknownIdentifier).toEqual(GENERIC);
    expect(wrongShop).toEqual(wrongContact);
    expect(wrongContact).toEqual(unknownIdentifier);
  });

  it('fails generic for an UNINSTALLED shop (§5.5) and an unknown shopRef', async () => {
    const uninstalled = await makeService({
      accountState: 'UNINSTALLED',
    }).service.lookup(dto(), IP);
    expect(uninstalled).toEqual(GENERIC);

    const { service, query } = makeService({ accountState: 'ACTIVE' });
    const unknownRef = await service.lookup(
      dto({ shopRef: '000000000000' }),
      IP,
    );
    expect(unknownRef).toEqual(GENERIC);
    expect(query).not.toHaveBeenCalled(); // never touches the database
  });

  it('trips the S-38 IP throttle at the 11th attempt in 10 minutes', async () => {
    void redis.set(`track:thr:ip:${SHOP}:${ipHash}`, '10');
    const { service, query, inserts } = makeService({ accountState: 'ACTIVE' });

    const view = await service.lookup(dto(), IP);

    expect(view).toEqual(THROTTLED);
    // The attempt is still logged, but no match query ever runs.
    expect(inserts).toHaveLength(1);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('awb_normalized'),
      ),
    ).toBe(false);
  });

  it('trips the S-38 Shop throttle at the 31st attempt in an hour', async () => {
    void redis.set(`track:thr:shop:${SHOP}`, '30');
    const { service } = makeService({ accountState: 'ACTIVE' });
    expect(await service.lookup(dto(), IP)).toEqual(THROTTLED);
  });

  it('allows the 10th IP attempt and the 30th Shop attempt (boundary)', async () => {
    void redis.set(`track:thr:ip:${SHOP}:${ipHash}`, '9');
    void redis.set(`track:thr:shop:${SHOP}`, '29');
    const { service } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [shipmentRow()],
    });
    const view = await service.lookup(dto(), IP);
    expect(view.ok).toBe(true);
  });

  it('requires CAPTCHA after 5 consecutive failures and enforces the token', async () => {
    void redis.set(`track:fail:${SHOP}:${ipHash}`, '5');
    const { service } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [shipmentRow()],
    });

    // No token → generic failure WITH the captchaRequired flag (S-38 signal,
    // keyed on attempt counts, never on the identifier).
    const noToken = await service.lookup(dto(), IP);
    expect(noToken).toEqual({ ...GENERIC, captchaRequired: true });

    // Token rejected by the verifier → still gated.
    captcha.verify.mockResolvedValueOnce(false);
    const badToken = await service.lookup(dto({ captchaToken: 'x' }), IP);
    expect(badToken).toEqual({ ...GENERIC, captchaRequired: true });
    expect(captcha.verify).toHaveBeenCalledWith('x', ipHash);

    // Valid token → the gate opens and the lookup proceeds.
    const solved = await service.lookup(dto({ captchaToken: 'ok' }), IP);
    expect(solved.ok).toBe(true);
  });

  it('corroborates the consecutive-failure count from track_lookup_attempt', async () => {
    // Redis counter lost (flush); the durable log still gates at 5.
    const { service } = makeService({
      accountState: 'ACTIVE',
      attemptTail: [
        { success: false },
        { success: false },
        { success: false },
        { success: false },
        { success: false },
      ],
      awbRows: () => [shipmentRow()],
    });
    const view = await service.lookup(dto(), IP);
    expect(view).toEqual({ ...GENERIC, captchaRequired: true });
  });

  it('resets the consecutive-failure counter on success', async () => {
    void redis.set(`track:fail:${SHOP}:${ipHash}`, '3');
    const { service } = makeService({
      accountState: 'ACTIVE',
      attemptTail: [{ success: false }, { success: false }, { success: false }],
      awbRows: () => [shipmentRow()],
    });
    const view = await service.lookup(dto(), IP);
    expect(view.ok).toBe(true);
    expect(await redis.get(`track:fail:${SHOP}:${ipHash}`)).toBeNull();
  });

  it('logs every attempt with salted hashes only — never raw identifiers or IPs (§5.7 control 4, §12)', async () => {
    const rawIdentifier = 'SECRETORDER9';
    const { service, inserts } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [],
      orderRows: () => [],
    });

    await service.lookup(dto({ identifier: rawIdentifier }), IP);

    expect(inserts).toHaveLength(1);
    const params = inserts[0];
    expect(params[0]).toBe(SHOP);
    expect(params[1]).toBe(ipHash); // salted hash of the IP
    expect(params[2]).toBe(saltedPiiHash(SALT, rawIdentifier)); // salted hash
    expect(params[3]).toBe(false);
    expect(JSON.stringify(params)).not.toContain(IP);
    expect(JSON.stringify(params)).not.toContain(rawIdentifier);
  });

  it('logs successes too (success = true)', async () => {
    const { service, inserts } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [shipmentRow()],
    });
    await service.lookup(dto(), IP);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][3]).toBe(true);
  });

  it('matches a contact only against the FULL normalized value (no partials)', async () => {
    const { service } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [shipmentRow()],
    });
    // Last 4 digits of the phone must NOT match.
    const partial = await service.lookup(dto({ contact: '3210' }), IP);
    expect(partial).toEqual(GENERIC);
    // The full number with formatting noise DOES match (+91 prefix, spaces).
    const full = await service.lookup(
      dto({ contact: '+91 98765 43210' }),
      IP,
    );
    expect(full.ok).toBe(true);
  });

  it('a redacted recipient can never match — buyer access revoked (§5.5)', async () => {
    const { service } = makeService({
      accountState: 'ACTIVE',
      awbRows: () => [shipmentRow({ snapshot: { ...SNAPSHOT, recipient: null } })],
    });
    expect(await service.lookup(dto(), IP)).toEqual(GENERIC);
  });

  it('hosted page URLs never embed the internal shop_id', () => {
    expect(REF).toMatch(/^[0-9a-f]{12}$/);
    expect(REF).not.toContain(SHOP);
    expect(`${APP_URL}/track/${REF}`).not.toContain(SHOP);
  });
});
