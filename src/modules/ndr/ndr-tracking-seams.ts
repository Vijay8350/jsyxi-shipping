import { Injectable } from '@nestjs/common';
import { TrackingSeams } from '../tracking/tracking-seams';
import { NdrActionService } from './ndr-action.service';
import { NdrCaseService } from './ndr-case.service';
import { NdrSettingsService } from './ndr-settings.service';
import type { CarrierEventStatus, MovementState } from '../tracking/tracking.types';

/**
 * The NDR suite's binding of the tracking seam (TRACKING_SEAMS in
 * tracking-seams.ts): machine F (§3.10) driven by the §3.4 reducer.
 *
 *  - onNdr (UNDELIVERED_ATTEMPT): open the case on the first attempt;
 *    re-open with attempt_count++ on a further attempt after a scheduled
 *    reattempt; record the attempt otherwise.
 *  - S-43: when auto-reattempt-once is ON, the FIRST UNDELIVERED_ATTEMPT
 *    auto-submits a REATTEMPT as the system actor (§3.10 row 2:
 *    "System (auto-reattempt, S-43)").
 *  - onDelivered: DELIVERED is a terminal MOVEMENT_STATE (§3.4) → CLOSED.
 *  - closeOnTerminalMovement: the parent wires this for the remaining
 *    terminal states (RTO_DELIVERED, LOST_OR_DAMAGED, CANCELLED_BY_COURIER),
 *    which the reducer's current seam calls do not cover.
 */
@Injectable()
export class NdrTrackingSeams implements TrackingSeams {
  constructor(
    private readonly cases: NdrCaseService,
    private readonly actions: NdrActionService,
    private readonly settings: NdrSettingsService,
  ) {}

  async onNdr(input: {
    shopId: string;
    shipmentId: string;
    carrierEventStatus: CarrierEventStatus;
    occurredAt: string;
  }): Promise<void> {
    if (input.carrierEventStatus !== 'UNDELIVERED_ATTEMPT') return;
    const outcome = await this.cases.handleUndeliveredAttempt({
      shopId: input.shopId,
      shipmentId: input.shipmentId,
      occurredAt: input.occurredAt,
    });

    // S-43: auto-reattempt once — only the first attempt (case just OPENED,
    // attempt_count 1) and only when the merchant turned it on (§9.8.2).
    if (outcome.kind === 'OPENED' && outcome.caseRow.attempt_count === 1) {
      const settings = await this.settings.get(input.shopId);
      if (settings.auto_reattempt_once) {
        await this.actions.submit({
          shopId: input.shopId,
          ndrCaseId: outcome.caseRow.ndr_case_id,
          action: 'REATTEMPT',
          payload: { source: 'AUTO_REATTEMPT_S43' },
          actorMemberId: null, // system actor (§3.10: "System (auto-reattempt, S-43)")
        });
      }
    }
  }

  /** DELIVERED is terminal (§3.4) → the case CLOSES (§3.10 terminal row). */
  async onDelivered(input: {
    shopId: string;
    shipmentId: string;
    occurredAt: string;
  }): Promise<void> {
    await this.cases.closeOnTerminalMovement({
      shopId: input.shopId,
      shipmentId: input.shipmentId,
      movementState: 'DELIVERED',
      occurredAt: input.occurredAt,
    });
  }

  /**
   * Parent wiring point: call this when the reducer reaches a terminal
   * MOVEMENT_STATE other than DELIVERED (RTO_DELIVERED, LOST_OR_DAMAGED,
   * CANCELLED_BY_COURIER) so machine F's terminal row fires there too.
   */
  async closeOnTerminalMovement(input: {
    shopId: string;
    shipmentId: string;
    movementState: MovementState;
    occurredAt: string;
  }): Promise<void> {
    await this.cases.closeOnTerminalMovement(input);
  }
}
