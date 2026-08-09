import { describe, expect, it, vi } from 'vitest';
import { NdrTrackingSeams } from '../../src/modules/ndr/ndr-tracking-seams';
import type { NdrActionService } from '../../src/modules/ndr/ndr-action.service';
import type { NdrCaseService } from '../../src/modules/ndr/ndr-case.service';
import type { NdrSettingsService } from '../../src/modules/ndr/ndr-settings.service';
import { NDR_SETTINGS_DEFAULTS } from '../../src/modules/ndr/ndr-settings.service';
import { caseRow, FIRST_NDR_AT, NDR_CASE_ID, SHIPMENT_ID, SHOP_ID } from './helpers';

/**
 * The tracking-seam binding (TRACKING_SEAMS → machine F): open on first
 * attempt, S-43 auto-reattempt-once, CLOSE on terminal movement.
 */

function mk(opts: { autoReattempt?: boolean; openKind?: string } = {}) {
  const cases = {
    handleUndeliveredAttempt: vi.fn().mockResolvedValue({
      kind: opts.openKind ?? 'OPENED',
      caseRow: caseRow({ ndr_case_id: NDR_CASE_ID, attempt_count: 1 }),
    }),
    closeOnTerminalMovement: vi.fn().mockResolvedValue(null),
  };
  const actions = { submit: vi.fn().mockResolvedValue({ submitted: true }) };
  const settings = {
    get: vi.fn().mockResolvedValue({
      shop_id: SHOP_ID,
      version: 1,
      ...NDR_SETTINGS_DEFAULTS,
      auto_reattempt_once: opts.autoReattempt ?? false,
    }),
  };
  const seams = new NdrTrackingSeams(
    cases as unknown as NdrCaseService,
    actions as unknown as NdrActionService,
    settings as unknown as NdrSettingsService,
  );
  return { seams, cases, actions, settings };
}

const EVENT = {
  shopId: SHOP_ID,
  shipmentId: SHIPMENT_ID,
  carrierEventStatus: 'UNDELIVERED_ATTEMPT' as const,
  occurredAt: FIRST_NDR_AT,
};

describe('NdrTrackingSeams.onNdr', () => {
  it('opens the case on UNDELIVERED_ATTEMPT; no auto-reattempt when S-43 is off', async () => {
    const { seams, cases, actions } = mk({ autoReattempt: false });

    await seams.onNdr(EVENT);

    expect(cases.handleUndeliveredAttempt).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      occurredAt: FIRST_NDR_AT,
    });
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it('S-43 ON: the FIRST attempt auto-submits a REATTEMPT as the system actor (§3.10)', async () => {
    const { seams, actions } = mk({ autoReattempt: true });

    await seams.onNdr(EVENT);

    expect(actions.submit).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      ndrCaseId: NDR_CASE_ID,
      action: 'REATTEMPT',
      payload: { source: 'AUTO_REATTEMPT_S43' },
      actorMemberId: null,
    });
  });

  it('S-43 ON but not the first attempt (re-opened case): no auto-reattempt', async () => {
    const { seams, actions } = mk({ autoReattempt: true, openKind: 'REOPENED' });

    await seams.onNdr(EVENT);

    expect(actions.submit).not.toHaveBeenCalled();
  });

  it('ignores non-UNDELIVERED_ATTEMPT statuses', async () => {
    const { seams, cases } = mk();
    await seams.onNdr({ ...EVENT, carrierEventStatus: 'IN_TRANSIT' });
    expect(cases.handleUndeliveredAttempt).not.toHaveBeenCalled();
  });
});

describe('NdrTrackingSeams — CLOSE on terminal movement (§3.10 terminal row)', () => {
  it('onDelivered closes the case (DELIVERED is terminal, §3.4)', async () => {
    const { seams, cases } = mk();

    await seams.onDelivered({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      occurredAt: FIRST_NDR_AT,
    });

    expect(cases.closeOnTerminalMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementState: 'DELIVERED' }),
    );
  });

  it('closeOnTerminalMovement delegates the other terminal states', async () => {
    const { seams, cases } = mk();

    await seams.closeOnTerminalMovement({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      movementState: 'RTO_DELIVERED',
      occurredAt: FIRST_NDR_AT,
    });

    expect(cases.closeOnTerminalMovement).toHaveBeenCalledWith(
      expect.objectContaining({ movementState: 'RTO_DELIVERED' }),
    );
  });
});
