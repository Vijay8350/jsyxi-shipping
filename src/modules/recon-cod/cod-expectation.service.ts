import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { paiseToRupees, rupeesToPaise } from '../../common/money';
import { CodSettingsService } from './cod-settings.service';
import { computeDueDate, deriveCodState, localDateString, DEFAULT_TIMEZONE } from './cod-state';
import type { CodExpectedRow } from './recon-cod.types';

interface ShipmentForExpectation {
  shipment_id: string;
  courier_account_id: string | null;
  is_test: boolean;
  collectible: string;
  snapshot: { formulaInputs?: { collectible?: string } } | null;
}

/**
 * §9.17.3: one recon_cod_expected row per Collectible-bearing NON-TEST
 * Shipment that reaches DELIVERED (INV-19). The expected amount is the
 * Collectible from the frozen booking snapshot (INV-8/INV-10), the due date
 * is F-21 in shop-local time, and creation is idempotent on
 * (shipment_id) via the UNIQUE key. §4.7: a Collectible-bearing Shipment
 * that goes RTO records RTO_UNCOLLECTED — terminal, never a Short.
 *
 * Money boundary (INV-23): an expectation records money owed BETWEEN the
 * courier and the merchant; creating or transitioning it moves no money.
 */
@Injectable()
export class CodExpectationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly settings: CodSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** S-2 shop timezone, defaulting to Asia/Kolkata (§5.2). */
  private async shopTimezone(shopId: string): Promise<string> {
    const res = await this.pool.query<{ timezone: string }>(
      `SELECT timezone FROM store_settings WHERE shop_id = $1`,
      [shopId],
    );
    return res.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  }

  /**
   * Tracking seam: DELIVERED. Creates the expectation when the Shipment
   * carries a Collectible > 0 and is non-test (INV-19 both directions).
   * A repeat DELIVERED (or a late one after RTO) is an ON CONFLICT no-op —
   * RTO_UNCOLLECTED is terminal and is never regressed (§3.15, INV-17).
   */
  async createOnDelivered(input: {
    shopId: string;
    shipmentId: string;
    occurredAt: string;
  }): Promise<{ created: boolean; expectedId?: string }> {
    const res = await this.pool.query<ShipmentForExpectation>(
      `SELECT shipment_id, courier_account_id, is_test, collectible::text, snapshot
         FROM shipment WHERE shop_id = $1 AND shipment_id = $2`,
      [input.shopId, input.shipmentId],
    );
    const shipment = res.rows[0];
    if (!shipment || shipment.is_test) return { created: false }; // INV-19

    // INV-8: the Collectible comes from the frozen snapshot, not live data.
    const collectibleText =
      shipment.snapshot?.formulaInputs?.collectible ?? shipment.collectible;
    const collectiblePaise = rupeesToPaise(collectibleText);
    if (collectiblePaise <= 0n) return { created: false }; // §4.7: prepaid docket

    const [dueDays, timeZone] = await Promise.all([
      this.settings.effectiveCodDueDays(input.shopId, shipment.courier_account_id),
      this.shopTimezone(input.shopId),
    ]);
    const deliveredAt = new Date(input.occurredAt);
    const dueAt = computeDueDate(deliveredAt, dueDays, timeZone); // F-21

    const inserted = await this.pool.query<{ expected_id: string }>(
      `INSERT INTO recon_cod_expected
         (shop_id, shipment_id, expected_amount, delivered_at, due_at, state)
       VALUES ($1, $2, $3::numeric, $4, $5::date, 'AWAITING')
       ON CONFLICT (shipment_id) DO NOTHING
       RETURNING expected_id`,
      [
        input.shopId,
        input.shipmentId,
        paiseToRupees(collectiblePaise),
        deliveredAt.toISOString(),
        dueAt,
      ],
    );
    const row = inserted.rows[0];
    if (!row) return { created: false }; // idempotent re-delivery

    // §12: expectation creation is a SYSTEM event (no HTTP actor).
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'SYSTEM',
      action: 'recon_cod.expected.create',
      objectType: 'recon_cod_expected',
      objectId: row.expected_id,
      after: {
        shipment_id: input.shipmentId,
        expected_amount: paiseToRupees(collectiblePaise),
        delivered_at: deliveredAt.toISOString(),
        due_at: dueAt,
        state: 'AWAITING',
      },
    });
    return { created: true, expectedId: row.expected_id };
  }

  /**
   * §4.7: an RTO movement (RTO_INITIATED / RTO_IN_TRANSIT /
   * RTO_OUT_FOR_DELIVERY / RTO_DELIVERED) flips an EXISTING expectation to
   * RTO_UNCOLLECTED — terminal (§3.15) and never a Short. When no
   * expectation exists (the Shipment never reached DELIVERED) there is
   * nothing to flip: §9.17.3 creates the row only on DELIVERED.
   */
  async markRtoUncollected(input: {
    shopId: string;
    shipmentId: string;
    occurredAt: string;
  }): Promise<{ flipped: boolean }> {
    const res = await this.pool.query<CodExpectedRow>(
      `SELECT expected_id, state, version
         FROM recon_cod_expected
        WHERE shop_id = $1 AND shipment_id = $2`,
      [input.shopId, input.shipmentId],
    );
    const existing = res.rows[0];
    if (!existing || existing.state === 'RTO_UNCOLLECTED') return { flipped: false };

    const updated = await this.pool.query<{ expected_id: string }>(
      `UPDATE recon_cod_expected
          SET state = 'RTO_UNCOLLECTED', version = version + 1
        WHERE expected_id = $1 AND version = $2
        RETURNING expected_id`,
      [existing.expected_id, existing.version],
    );
    if (!updated.rows[0]) return { flipped: false }; // lost a race; terminal either way

    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'SYSTEM',
      action: 'recon_cod.expected.rto_uncollected',
      objectType: 'recon_cod_expected',
      objectId: existing.expected_id,
      before: { state: existing.state },
      after: { state: 'RTO_UNCOLLECTED' },
      reason: '§4.7: Collectible-bearing Shipment went RTO — never a Short',
    });
    return { flipped: true };
  }

  /**
   * F-13/F-21 recompute after an allocation lands (§3.15: derived, never
   * terminal except RTO_UNCOLLECTED). Reads the append-only allocation sum
   * and rewrites the derived state when it changed.
   */
  async recomputeState(shopId: string, expectedId: string): Promise<CodExpectedRow | null> {
    const res = await this.pool.query<CodExpectedRow & { allocated: string; timezone: string | null }>(
      `SELECT e.expected_id, e.shop_id, e.shipment_id, e.expected_amount::text,
              e.delivered_at, e.due_at::text, e.state, e.version,
              COALESCE(SUM(a.amount), 0)::text AS allocated,
              (SELECT ss.timezone FROM store_settings ss WHERE ss.shop_id = e.shop_id) AS timezone
         FROM recon_cod_expected e
         LEFT JOIN recon_cod_allocation a ON a.expected_id = e.expected_id
        WHERE e.shop_id = $1 AND e.expected_id = $2
        GROUP BY e.expected_id`,
      [shopId, expectedId],
    );
    const row = res.rows[0];
    if (!row) return null;

    const expectedPaise = rupeesToPaise(row.expected_amount);
    const allocatedPaise = rupeesToPaise(row.allocated);
    const shipment = await this.pool.query<{ courier_account_id: string | null }>(
      `SELECT courier_account_id FROM shipment WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, row.shipment_id],
    );
    const tolerancePaise = await this.settings.effectiveCodTolerance(
      shopId,
      shipment.rows[0]?.courier_account_id ?? null,
    );

    const next = deriveCodState({
      expectedPaise,
      allocatedPaise,
      tolerancePaise,
      dueAt: row.due_at.slice(0, 10),
      todayLocal: localDateString(new Date(), row.timezone ?? DEFAULT_TIMEZONE),
      current: row.state,
    });
    if (next === row.state) return row;

    await this.pool.query(
      `UPDATE recon_cod_expected
          SET state = $2, version = version + 1
        WHERE expected_id = $1 AND state <> 'RTO_UNCOLLECTED'`,
      [row.expected_id, next],
    );
    return { ...row, state: next };
  }
}
