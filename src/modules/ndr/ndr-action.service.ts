import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { AdapterCallerService } from '../courier-framework/adapter-caller.service';
import {
  NdrActionResult,
  UnsupportedCapabilityError,
} from '../courier-framework/adapter.types';
import { NdrCaseService } from './ndr-case.service';
import { NdrAction, NdrActionRow, NdrCaseRow } from './ndr.types';

export interface NdrSubmitInput {
  shopId: string;
  ndrCaseId: string;
  action: NdrAction;
  payload?: Record<string, unknown>;
  /** null = system actor (auto-reattempt S-43, ADD-27 buyer response). */
  actorMemberId: string | null;
}

export type NdrSubmitResult =
  | {
      submitted: true;
      ndrActionId: string;
      /** Final case state after the ack transition (machine F). */
      caseState: 'REATTEMPT_SCHEDULED' | 'RTO_REQUESTED';
      providerAck: string | null;
    }
  | {
      submitted: false;
      code: 'CAPABILITY_UNSUPPORTED';
      /** A1-03: the documented manual fallback is always shown, never a
       *  silent no-op. */
      manualFallbackNote: string | null;
    }
  | {
      submitted: false;
      code: 'PROVIDER_REJECTED' | 'INVALID_CASE_STATE' | 'TRANSPORT_ERROR';
      message: string;
    };

interface ShipmentContext {
  shipment_id: string;
  awb_normalized: string | null;
  courier_account_id: string | null;
  movement_state: string;
  is_test: boolean;
}

/**
 * §9.8.1 NDR actions (machine F §3.10): Operator+ (or system) submits an
 * ndr_action through the courier adapter's ndrAction method, always via
 * AdapterCallerService (the §8.2 transport policy). This service is also the
 * seam ADD-27's buyer-response processor calls.
 *
 * A1-03: where courier_capability says ndrAction is supported = false the
 * action is REFUSED with the documented manual fallback note — never a
 * silent no-op. Every action row is persisted with the provider ack/result,
 * accepted or not.
 */
@Injectable()
export class NdrActionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly cases: NdrCaseService,
    private readonly caller: AdapterCallerService,
    private readonly audit: AuditService,
  ) {}

  async submit(input: NdrSubmitInput): Promise<NdrSubmitResult> {
    const caseRow = await this.cases.getCase(input.shopId, input.ndrCaseId);
    const actor = {
      kind: (input.actorMemberId ? 'MEMBER' : 'SYSTEM') as 'MEMBER' | 'SYSTEM',
      id: input.actorMemberId,
    };

    // Machine F: an ndr_action is taken from OPEN only. (REATTEMPT_SCHEDULED
    // re-opens on a further attempt; CLOSED and RTO_REQUESTED take none.)
    if (caseRow.state !== 'OPEN') {
      return {
        submitted: false,
        code: 'INVALID_CASE_STATE',
        message: `ndr_action requires an OPEN case; case is ${caseRow.state} (§3.10)`,
      };
    }

    const shipment = await this.loadShipment(input.shopId, caseRow.shipment_id);
    if (!shipment.awb_normalized || !shipment.courier_account_id) {
      return {
        submitted: false,
        code: 'PROVIDER_REJECTED',
        message: 'shipment has no active AWB / courier account',
      };
    }

    // A1-03 capability gate, checked from courier_capability BEFORE any call.
    const capability = await this.loadCapability(input.shopId, caseRow.shipment_id);
    if (capability && capability.supported === false) {
      return {
        submitted: false,
        code: 'CAPABILITY_UNSUPPORTED',
        manualFallbackNote: capability.manual_fallback_note,
      };
    }

    let result: NdrActionResult;
    try {
      result = await this.caller.call(
        input.shopId,
        shipment.courier_account_id,
        'ndrAction',
        (adapter) =>
          adapter.ndrAction({
            awb: shipment.awb_normalized as string,
            action: input.action,
            payload: input.payload ?? {},
          }),
      );
    } catch (err) {
      if (err instanceof UnsupportedCapabilityError) {
        // The adapter's own declaration (A1-03): refuse with the fallback.
        return {
          submitted: false,
          code: 'CAPABILITY_UNSUPPORTED',
          manualFallbackNote: err.manualFallbackNote,
        };
      }
      const message = err instanceof Error ? err.message : 'adapter call failed';
      await this.persistAction(caseRow, input, null, `TRANSPORT_ERROR: ${message}`);
      return { submitted: false, code: 'TRANSPORT_ERROR', message };
    }

    // The provider answered. Machine F: OPEN → ACTION_SUBMITTED …
    const submittedCase = await this.cases.markActionSubmitted(caseRow, actor);

    if (!result.accepted) {
      // … reverse row: provider rejection returns the case to OPEN.
      await this.persistAction(
        caseRow,
        input,
        result.providerAck,
        'REJECTED_BY_PROVIDER',
      );
      await this.cases.returnToOpenOnProviderRejection(submittedCase);
      return {
        submitted: false,
        code: 'PROVIDER_REJECTED',
        message: result.providerAck ?? 'provider rejected the ndr_action',
      };
    }

    // … then the ack row: reattempt ack → REATTEMPT_SCHEDULED, RTO ack →
    // RTO_REQUESTED (§3.10).
    const actionRow = await this.persistAction(
      caseRow,
      input,
      result.providerAck,
      'ACCEPTED',
    );
    const finalCase =
      input.action === 'INITIATE_RTO'
        ? await this.cases.markRtoRequested(submittedCase)
        : await this.cases.markReattemptScheduled(submittedCase);

    await this.audit.record({
      shopId: input.shopId,
      actorKind: actor.kind,
      actorId: actor.id,
      action: 'ndr_action.submit',
      objectType: 'ndr_case',
      objectId: caseRow.ndr_case_id,
      after: {
        ndr_action_id: actionRow.ndr_action_id,
        action: input.action,
        accepted: true,
      },
    });

    return {
      submitted: true,
      ndrActionId: actionRow.ndr_action_id,
      caseState: finalCase.state as 'REATTEMPT_SCHEDULED' | 'RTO_REQUESTED',
      providerAck: result.providerAck,
    };
  }

  /** §9.8.1 + ADD-36: the bulk NDR action — one submit per case, partial
   *  results reported per case like §9.5.2 (never all-or-nothing). */
  async submitBulk(input: {
    shopId: string;
    ndrCaseIds: string[];
    action: NdrAction;
    payload?: Record<string, unknown>;
    actorMemberId: string | null;
  }): Promise<Array<{ ndrCaseId: string; result: NdrSubmitResult }>> {
    const out: Array<{ ndrCaseId: string; result: NdrSubmitResult }> = [];
    for (const ndrCaseId of input.ndrCaseIds) {
      try {
        const result = await this.submit({
          shopId: input.shopId,
          ndrCaseId,
          action: input.action,
          payload: input.payload,
          actorMemberId: input.actorMemberId,
        });
        out.push({ ndrCaseId, result });
      } catch (err) {
        out.push({
          ndrCaseId,
          result: {
            submitted: false,
            code: 'TRANSPORT_ERROR',
            message: err instanceof Error ? err.message : 'submit failed',
          },
        });
      }
    }
    return out;
  }

  private async persistAction(
    caseRow: NdrCaseRow,
    input: NdrSubmitInput,
    providerAck: string | null,
    resultText: string,
  ): Promise<NdrActionRow> {
    const res = await this.pool.query<NdrActionRow>(
      `INSERT INTO ndr_action
         (ndr_case_id, action, actor_member_id, payload, provider_ack, result)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        caseRow.ndr_case_id,
        input.action,
        input.actorMemberId,
        JSON.stringify(input.payload ?? {}),
        providerAck,
        resultText,
      ],
    );
    return res.rows[0];
  }

  private async loadShipment(shopId: string, shipmentId: string): Promise<ShipmentContext> {
    const res = await this.pool.query<ShipmentContext>(
      `SELECT shipment_id, awb_normalized, courier_account_id, movement_state, is_test
         FROM shipment
        WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, shipmentId],
    );
    if (res.rowCount === 0) throw new NotFoundException('shipment not found');
    return res.rows[0];
  }

  /** courier_capability.ndrAction for the shipment's courier (A1-03). */
  private async loadCapability(
    shopId: string,
    shipmentId: string,
  ): Promise<{ supported: boolean; manual_fallback_note: string | null } | null> {
    const res = await this.pool.query<{
      supported: boolean;
      manual_fallback_note: string | null;
    }>(
      `SELECT cc.supported, cc.manual_fallback_note
         FROM shipment s
         JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
         JOIN courier_capability cc
           ON cc.courier_id = ca.courier_id AND cc.capability = 'ndrAction'
        WHERE s.shop_id = $1 AND s.shipment_id = $2`,
      [shopId, shipmentId],
    );
    return res.rows[0] ?? null;
  }
}
