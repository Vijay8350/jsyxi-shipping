import { describe, expect, it } from 'vitest';
import { mockAudit } from '../booking/helpers';
import {
  FnPool,
  OUTBOX_ID,
  SHOP_ID,
  FULFILLMENT_GID,
  IDEMPOTENCY_KEY,
  mockBudget,
  mockMutations,
  outboxRow,
} from './helpers';
import {
  SyncBackWorkerService,
  SYNC_BACK_QUEUE_NAME,
} from '../../src/modules/sync-back/sync-back-worker.service';
import { nextAttemptAt, retryDelayMs, SYNC_MAX_ATTEMPTS } from '../../src/modules/sync-back/retry-policy';
import { THROTTLE_DEFER_MS } from '../../src/modules/sync-back/cost-budget';
import type { ShopifySyncMutations } from '../../src/modules/sync-back/shopify-sync.mutations';
import type { SyncCostBudget } from '../../src/modules/sync-back/cost-budget';
import type { SyncOutboxRow } from '../../src/modules/sync-back/sync-back.types';

/**
 * The §3.17 outbox machine: PENDING → IN_FLIGHT → SUCCEEDED; failure →
 * RETRYING on the S-48 schedule (asserted attempt by attempt); the 10th
 * failure → DEAD + Shop-scoped DLQ + audit; the §8.4 cost budget defers
 * without consuming attempts.
 */

const NOW = new Date('2026-07-31T10:00:00.000Z');

function worker(
  pool: FnPool,
  mutations = mockMutations(),
  budget = mockBudget(),
  audit = mockAudit(),
) {
  const svc = new SyncBackWorkerService(
    pool.asPool(),
    mutations as unknown as ShopifySyncMutations,
    budget as unknown as SyncCostBudget,
    audit as never,
  );
  return { svc, mutations, budget, audit };
}

describe('claim (§3.17, A1-10)', () => {
  it('claims due PENDING/RETRYING rows FOR UPDATE SKIP LOCKED into IN_FLIGHT', async () => {
    const claimed = outboxRow();
    const pool = new FnPool().on(/UPDATE sync_outbox/, [claimed]);
    const { svc } = worker(pool);

    const rows = await svc.claimDueBatch(25, NOW);

    expect(rows).toEqual([claimed]);
    const call = pool.matching(/UPDATE sync_outbox/)[0]!;
    expect(call.sql).toContain("SET state = 'IN_FLIGHT'");
    expect(call.sql).toContain("state IN ('PENDING', 'RETRYING')");
    expect(call.sql).toContain('next_attempt_at <= $1');
    expect(call.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(call.params).toEqual([NOW.toISOString(), 25]);
  });
});

describe('PENDING → IN_FLIGHT → SUCCEEDED (§3.17)', () => {
  it('executes the GraphQL mutation and marks the row SUCCEEDED', async () => {
    const pool = new FnPool().on(/UPDATE sync_outbox/, [], 1);
    const { svc, mutations } = worker(pool);
    const row = outboxRow();

    await svc.processClaimed(row, NOW);

    expect(mutations.createFulfillment).toHaveBeenCalledWith(SHOP_ID, row.payload);
    const update = pool.matching(/UPDATE sync_outbox/)[0]!;
    expect(update.sql).toContain("state = 'SUCCEEDED'");
    expect(update.params[0]).toBe(OUTBOX_ID);
  });

  it('writes the fulfillment GID back into the create payload (§8.4)', async () => {
    const pool = new FnPool().on(/UPDATE sync_outbox/, [], 1);
    const { svc } = worker(pool);

    await svc.processClaimed(outboxRow(), NOW);

    const update = pool.matching(/UPDATE sync_outbox/)[0]!;
    expect(update.sql).toContain('fulfillmentGid');
    expect(update.params).toEqual([OUTBOX_ID, FULFILLMENT_GID]);
  });

  it('processDueBatch claims then executes the batch', async () => {
    const claimed = outboxRow();
    const pool = new FnPool()
      .on(/IN_FLIGHT/, [claimed]) // the claim UPDATE … RETURNING
      .on(/SUCCEEDED/, [], 1); // the success UPDATE
    const { svc, mutations } = worker(pool);

    await svc.processDueBatch(25, NOW);

    expect(mutations.createFulfillment).toHaveBeenCalledTimes(1);
    expect(pool.matching(/SUCCEEDED/)).toHaveLength(1);
  });
});

describe('failure → RETRYING on the S-48 schedule (§8.6)', () => {
  it.each([1, 2, 3, 5, 9])(
    'failure of attempt %i schedules the deterministic backoff',
    async (attempt) => {
      const pool = new FnPool().on(/UPDATE sync_outbox/, [], 1);
      const mutations = mockMutations();
      mutations.createFulfillment.mockRejectedValue(new Error('boom'));
      const { svc } = worker(pool, mutations);

      await svc.processClaimed(outboxRow({ attempts: attempt - 1 }), NOW);

      const update = pool.matching(/state = 'RETRYING'/)[0]!;
      expect(update.params[0]).toBe(OUTBOX_ID);
      expect(update.params[1]).toBe(attempt); // attempts++
      // next_attempt_at = now + retryDelayMs(attempt, idempotency_key) — the
      // S-48 schedule asserted attempt by attempt.
      expect(update.params[2]).toBe(
        nextAttemptAt(NOW, attempt, IDEMPOTENCY_KEY).toISOString(),
      );
      expect(update.params[2]).toBe(
        new Date(NOW.getTime() + retryDelayMs(attempt, IDEMPOTENCY_KEY)).toISOString(),
      );
      // Not DEAD, no DLQ row.
      expect(pool.matching(/state = 'DEAD'/)).toHaveLength(0);
      expect(pool.matching(/INSERT INTO dlq_item/)).toHaveLength(0);
    },
  );
});

describe('the 10th failure → DEAD + Shop-scoped DLQ + audit (§8.6, §3.17)', () => {
  it('moves to DEAD, writes dlq_item and audits as SYSTEM', async () => {
    const pool = new FnPool()
      .on(/UPDATE sync_outbox/, [], 1)
      .on(/INSERT INTO dlq_item/, [], 1);
    const mutations = mockMutations();
    mutations.createFulfillment.mockRejectedValue(new Error('boom'));
    const { svc, audit } = worker(pool, mutations);

    await svc.processClaimed(outboxRow({ attempts: SYNC_MAX_ATTEMPTS - 1 }), NOW);

    const dead = pool.matching(/state = 'DEAD'/)[0]!;
    expect(dead.params).toEqual([OUTBOX_ID, SYNC_MAX_ATTEMPTS]);

    const dlq = pool.matching(/INSERT INTO dlq_item/)[0]!;
    expect(dlq.params[0]).toBe(SHOP_ID); // Shop-scoped DLQ
    expect(dlq.params[1]).toBe(SYNC_BACK_QUEUE_NAME); // 'shopify-sync'
    expect(JSON.parse(dlq.params[2] as string)).toEqual({
      outbox_id: OUTBOX_ID,
      operation: 'CREATE_FULFILLMENT',
    });
    expect(dlq.params[4]).toBe(SYNC_MAX_ATTEMPTS);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      shopId: SHOP_ID,
      actorKind: 'SYSTEM',
      action: 'sync_outbox.dead',
      objectType: 'sync_outbox',
      objectId: OUTBOX_ID,
      after: { state: 'DEAD', attempts: SYNC_MAX_ATTEMPTS },
    });
    // No retry scheduled for a DEAD row.
    expect(pool.matching(/state = 'RETRYING'/)).toHaveLength(0);
  });
});

describe('§8.4 per-Shop cost budget', () => {
  it('defers a throttled row without consuming an attempt', async () => {
    const pool = new FnPool().on(/UPDATE sync_outbox/, [], 1);
    const mutations = mockMutations();
    const { svc, budget } = worker(pool, mutations, mockBudget(false));

    await svc.processClaimed(outboxRow({ attempts: 0 }), NOW);

    expect(budget.tryConsume).toHaveBeenCalledWith(SHOP_ID);
    expect(mutations.createFulfillment).not.toHaveBeenCalled();

    const update = pool.matching(/UPDATE sync_outbox/)[0]!;
    // Back to PENDING (no prior attempts), deferred by the throttle window…
    expect(update.params).toEqual([
      OUTBOX_ID,
      'PENDING',
      new Date(NOW.getTime() + THROTTLE_DEFER_MS).toISOString(),
    ]);
    // …with no attempt consumed and no retry/dead path touched.
    expect(pool.matching(/attempts =/)).toHaveLength(0);
    expect(pool.matching(/INSERT INTO dlq_item/)).toHaveLength(0);
  });

  it('returns a throttled retry to RETRYING (attempts preserved)', async () => {
    const pool = new FnPool().on(/UPDATE sync_outbox/, [], 1);
    const { svc } = worker(pool, mockMutations(), mockBudget(false));

    await svc.processClaimed(outboxRow({ attempts: 3 }), NOW);

    const update = pool.matching(/UPDATE sync_outbox/)[0]!;
    expect(update.params[1]).toBe('RETRYING');
  });
});

describe('event execution resolves the fulfillment GID at run time', () => {
  it('uses the SUCCEEDED create row when the payload has no GID', async () => {
    const pool = new FnPool()
      .on(/FROM sync_outbox/, [{ gid: FULFILLMENT_GID }])
      .on(/UPDATE sync_outbox/, [], 1);
    const mutations = mockMutations();
    const { svc } = worker(pool, mutations);
    const row: SyncOutboxRow = outboxRow({
      operation: 'ADD_FULFILLMENT_EVENT',
      payload: {
        carrierEventStatus: 'DELIVERED',
        shopifyStatus: 'DELIVERED',
        message: 'DELIVERED',
        fulfillmentGid: null,
      },
    });

    await svc.processClaimed(row, NOW);

    expect(mutations.addFulfillmentEvent).toHaveBeenCalledWith(
      SHOP_ID,
      expect.objectContaining({
        fulfillmentGid: FULFILLMENT_GID,
        shopifyStatus: 'DELIVERED',
        message: 'DELIVERED',
      }),
    );
    expect(pool.matching(/SET state = 'SUCCEEDED'/)).toHaveLength(1);
  });
});
