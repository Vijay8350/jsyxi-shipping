import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  AUTO_RTO_WARN_HOURS,
  NdrCaseRow,
  NdrCaseState,
  normalizeNdrReason,
  TERMINAL_MOVEMENT_STATES,
} from './ndr.types';
import type { MovementState } from '../tracking/tracking.types';

/** Outcome kinds for handleUndeliveredAttempt (§3.10 machine F rows). */
export type NdrOpenKind =
  | 'OPENED' // — → OPEN: first UNDELIVERED_ATTEMPT with no open case
  | 'ATTEMPT_RECORDED' // repeat attempt while OPEN / RTO_REQUESTED: count + last_ndr_at
  | 'REOPENED' // REATTEMPT_SCHEDULED → OPEN on a further attempt (reverse row)
  | 'IGNORED'; // case already CLOSED — impossible per INV-17, tolerated

export interface NdrOpenOutcome {
  kind: NdrOpenKind;
  caseRow: NdrCaseRow;
}

const MAX_VERSION_RETRIES = 3;

/**
 * The §3.10 NDR case lifecycle — machine F, implemented exactly:
 *
 *  - — → OPEN on the first UNDELIVERED_ATTEMPT with no open case (the
 *    tracking seam, NdrTrackingSeams, calls handleUndeliveredAttempt).
 *  - OPEN → ACTION_SUBMITTED when the adapter accepts an ndr_action.
 *  - ACTION_SUBMITTED → REATTEMPT_SCHEDULED on a reattempt ack, → RTO_REQUESTED
 *    on an RTO ack.
 *  - Reverse rows: provider rejection returns ACTION_SUBMITTED → OPEN; a
 *    further UNDELIVERED_ATTEMPT returns REATTEMPT_SCHEDULED → OPEN with
 *    attempt_count incremented.
 *  - Any non-CLOSED state → CLOSED (terminal) on a terminal MOVEMENT_STATE.
 *
 * Aging is measured from first_ndr_at; auto_rto_warn_at = first_ndr_at + S-44
 * (48h, RW-05). Every state change is audited (§12). All transitions run
 * under the case's optimistic version check (INV-22's pattern): conditional
 * UPDATE on the version read; a mismatch re-reads and re-applies, never a
 * last-write-wins merge. Every query is shop-scoped (INV-1).
 */
@Injectable()
export class NdrCaseService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async getCase(shopId: string, ndrCaseId: string): Promise<NdrCaseRow> {
    const res = await this.pool.query<NdrCaseRow>(
      `SELECT * FROM ndr_case WHERE shop_id = $1 AND ndr_case_id = $2`,
      [shopId, ndrCaseId],
    );
    if (res.rowCount === 0) throw new NotFoundException('ndr case not found');
    return res.rows[0];
  }

  /** The open (non-CLOSED) case for a shipment, if any (INV-1 shop-scoped). */
  async findOpenCase(shopId: string, shipmentId: string): Promise<NdrCaseRow | null> {
    const res = await this.pool.query<NdrCaseRow>(
      `SELECT * FROM ndr_case
        WHERE shop_id = $1 AND shipment_id = $2 AND state <> 'CLOSED'
        ORDER BY created_at DESC LIMIT 1`,
      [shopId, shipmentId],
    );
    return res.rows[0] ?? null;
  }

  /** The latest case for a shipment in ANY state (machine F entry guard). */
  private async findLatestCase(shopId: string, shipmentId: string): Promise<NdrCaseRow | null> {
    const res = await this.pool.query<NdrCaseRow>(
      `SELECT * FROM ndr_case
        WHERE shop_id = $1 AND shipment_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [shopId, shipmentId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * The reason for an attempt comes from the carrier event's reason_text
   * (§3.10), normalized to the five NDR_REASON values; unmappable → OTHER,
   * never discarded (RV-14, INV-20). The seam signature carries no reason
   * text, so the latest UNDELIVERED_ATTEMPT event for the shipment is read.
   */
  private async latestAttemptReason(
    shopId: string,
    shipmentId: string,
  ): Promise<string | null> {
    const res = await this.pool.query<{ reason_text: string | null }>(
      `SELECT reason_text FROM tracking_event
        WHERE shop_id = $1 AND shipment_id = $2
          AND carrier_event_status = 'UNDELIVERED_ATTEMPT'
        ORDER BY occurred_at DESC LIMIT 1`,
      [shopId, shipmentId],
    );
    return res.rows[0]?.reason_text ?? null;
  }

  /** §3.10: the UNDELIVERED_ATTEMPT entry point (via the tracking seam). */
  async handleUndeliveredAttempt(input: {
    shopId: string;
    shipmentId: string;
    occurredAt: string;
  }): Promise<NdrOpenOutcome> {
    const reason = normalizeNdrReason(
      await this.latestAttemptReason(input.shopId, input.shipmentId),
    );
    // The LATEST case for the shipment regardless of state: a CLOSED case
    // means the shipment already reached a terminal MOVEMENT_STATE, and a
    // later NDR is impossible (INV-17) — a stray event is ignored, never
    // re-opened. Only "no case at all" opens a new one (machine F row 1).
    const existing = await this.findLatestCase(input.shopId, input.shipmentId);

    if (!existing) {
      // — → OPEN: first UNDELIVERED_ATTEMPT for a Shipment with no open case.
      const res = await this.pool.query<NdrCaseRow>(
        `INSERT INTO ndr_case
           (shop_id, shipment_id, attempt_count, reason_code,
            first_ndr_at, last_ndr_at, state, auto_rto_warn_at)
         VALUES ($1, $2, 1, $3, $4::timestamptz, $4::timestamptz, 'OPEN',
                 $4::timestamptz + ($5 || ' hours')::interval)
         RETURNING *`,
        [input.shopId, input.shipmentId, reason, input.occurredAt, AUTO_RTO_WARN_HOURS],
      );
      const caseRow = res.rows[0];
      await this.auditCase(caseRow, 'ndr_case.open', null, {
        state: 'OPEN',
        reason_code: reason,
        attempt_count: 1,
      });
      return { kind: 'OPENED', caseRow };
    }

    if (existing.state === 'CLOSED') {
      // INV-17: a terminal MOVEMENT_STATE makes a later NDR impossible; if a
      // stray event still arrives, store nothing new and leave CLOSED.
      return { kind: 'IGNORED', caseRow: existing };
    }

    if (existing.state === 'REATTEMPT_SCHEDULED') {
      // Reverse row: a further UNDELIVERED_ATTEMPT re-opens the case with
      // attempt_count incremented.
      const caseRow = await this.transition(existing, 'OPEN', {
        actorKind: 'SYSTEM',
        extraSets: ', attempt_count = attempt_count + 1, last_ndr_at = $5::timestamptz, reason_code = $6',
        extraParams: [input.occurredAt, reason],
        auditAction: 'ndr_case.reopen',
        auditNote: 'further UNDELIVERED_ATTEMPT after a scheduled reattempt',
      });
      return { kind: 'REOPENED', caseRow };
    }

    // OPEN / ACTION_SUBMITTED / RTO_REQUESTED: record the attempt (count and
    // last_ndr_at move; the state does not — no machine F row exits these
    // states on a carrier event).
    const res = await this.pool.query<NdrCaseRow>(
      `UPDATE ndr_case
          SET attempt_count = attempt_count + 1,
              last_ndr_at = $4::timestamptz,
              reason_code = $5,
              version = version + 1
        WHERE shop_id = $1 AND ndr_case_id = $2 AND version = $3
        RETURNING *`,
      [input.shopId, existing.ndr_case_id, existing.version, input.occurredAt, reason],
    );
    const caseRow = res.rows[0] ?? (await this.getCase(input.shopId, existing.ndr_case_id));
    return { kind: 'ATTEMPT_RECORDED', caseRow };
  }

  /**
   * §3.10 terminal row: any non-CLOSED state → CLOSED when the Shipment
   * reaches a terminal MOVEMENT_STATE (§3.4). Idempotent; CLOSED has no exit
   * (a later NDR is impossible after terminal, INV-17).
   */
  async closeOnTerminalMovement(input: {
    shopId: string;
    shipmentId: string;
    movementState: MovementState;
    occurredAt: string;
  }): Promise<NdrCaseRow | null> {
    if (!TERMINAL_MOVEMENT_STATES.includes(input.movementState)) return null;
    const existing = await this.findOpenCase(input.shopId, input.shipmentId);
    if (!existing) return null;
    return this.transition(existing, 'CLOSED', {
      actorKind: 'SYSTEM',
      auditAction: 'ndr_case.close',
      auditNote: `shipment reached terminal MOVEMENT_STATE ${input.movementState}`,
    });
  }

  /** OPEN → ACTION_SUBMITTED (adapter accepted the ndr_action). */
  async markActionSubmitted(
    caseRow: NdrCaseRow,
    actor: { kind: 'MEMBER' | 'SYSTEM'; id: string | null },
  ): Promise<NdrCaseRow> {
    return this.transition(caseRow, 'ACTION_SUBMITTED', {
      actorKind: actor.kind,
      actorId: actor.id,
      auditAction: 'ndr_case.action_submitted',
    });
  }

  /** ACTION_SUBMITTED → REATTEMPT_SCHEDULED (provider reattempt ack). */
  async markReattemptScheduled(caseRow: NdrCaseRow): Promise<NdrCaseRow> {
    return this.transition(caseRow, 'REATTEMPT_SCHEDULED', {
      actorKind: 'SYSTEM',
      auditAction: 'ndr_case.reattempt_scheduled',
    });
  }

  /** ACTION_SUBMITTED → RTO_REQUESTED (provider RTO ack). No reverse. */
  async markRtoRequested(caseRow: NdrCaseRow): Promise<NdrCaseRow> {
    return this.transition(caseRow, 'RTO_REQUESTED', {
      actorKind: 'SYSTEM',
      auditAction: 'ndr_case.rto_requested',
    });
  }

  /** Reverse row: the provider rejected the action → back to OPEN. */
  async returnToOpenOnProviderRejection(caseRow: NdrCaseRow): Promise<NdrCaseRow> {
    return this.transition(caseRow, 'OPEN', {
      actorKind: 'SYSTEM',
      auditAction: 'ndr_case.provider_rejected',
      auditNote: 'provider rejected the ndr_action; case returns to OPEN',
    });
  }

  /**
   * The only state writer. Guards the machine F from-state, applies a
   * conditional UPDATE on the version read (INV-22's pattern), and audits
   * (§12). A version mismatch re-reads and re-applies; a from-state mismatch
   * after retries is a conflict, never a silent merge.
   */
  private async transition(
    caseRow: NdrCaseRow,
    to: NdrCaseState,
    opts: {
      actorKind: 'MEMBER' | 'SYSTEM';
      actorId?: string | null;
      auditAction: string;
      auditNote?: string;
      extraSets?: string;
      extraParams?: unknown[];
    },
  ): Promise<NdrCaseRow> {
    const fromExpected = FROM_STATES[to].filter((s) => s !== to);
    let current = caseRow;
    for (let attempt = 1; attempt <= MAX_VERSION_RETRIES; attempt++) {
      if (current.state === to) return current; // idempotent
      if (!fromExpected.includes(current.state)) {
        throw new ConflictException(
          `machine F: ${current.state} → ${to} is not a listed transition (§3.10)`,
        );
      }
      // Placeholders $5+ belong to extraSets (used only by the reopen row).
      const res = await this.pool.query<NdrCaseRow>(
        `UPDATE ndr_case
            SET state = $3, version = version + 1${opts.extraSets ?? ''}
          WHERE shop_id = $1 AND ndr_case_id = $2 AND version = $4
        RETURNING *`,
        [current.shop_id, current.ndr_case_id, to, current.version, ...(opts.extraParams ?? [])],
      );
      if (res.rowCount && res.rowCount > 0) {
        const next = res.rows[0];
        await this.auditCase(next, opts.auditAction, { state: current.state }, {
          state: to,
          ...(opts.auditNote ? { note: opts.auditNote } : {}),
        }, opts.actorId ?? null, opts.actorKind);
        return next;
      }
      current = await this.getCase(caseRow.shop_id, caseRow.ndr_case_id);
    }
    throw new ConflictException('ndr_case version conflict');
  }

  private async auditCase(
    caseRow: NdrCaseRow,
    action: string,
    before: unknown,
    after: unknown,
    actorId: string | null = null,
    actorKind: 'MEMBER' | 'SYSTEM' = 'SYSTEM',
  ): Promise<void> {
    await this.audit.record({
      shopId: caseRow.shop_id,
      actorKind,
      actorId,
      action,
      objectType: 'ndr_case',
      objectId: caseRow.ndr_case_id,
      before,
      after,
    });
  }
}

/** §3.10 machine F: the listed from-states per target (CLOSED's guard is
 *  "any non-CLOSED state" per the terminal row). */
const FROM_STATES: Record<NdrCaseState, NdrCaseState[]> = {
  OPEN: ['ACTION_SUBMITTED', 'REATTEMPT_SCHEDULED'], // the two reverse rows
  ACTION_SUBMITTED: ['OPEN'],
  REATTEMPT_SCHEDULED: ['ACTION_SUBMITTED'],
  RTO_REQUESTED: ['ACTION_SUBMITTED'],
  CLOSED: ['OPEN', 'ACTION_SUBMITTED', 'REATTEMPT_SCHEDULED', 'RTO_REQUESTED'],
};
