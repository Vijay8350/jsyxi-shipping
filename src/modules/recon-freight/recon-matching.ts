import {
  Paise,
  applyRate,
  paiseToRupees,
  rateToMillionths,
  rupeesToPaise,
} from '../../common/money';
import {
  TariffInput,
  ZoneCode,
  auditedQuote,
  computeRtoExpectation,
} from '../rate-engine/pricing';
import {
  CONTROL_TOTAL_FLOOR_PAISE,
  CONTROL_TOTAL_PCT_DENOMINATOR,
  CONTROL_TOTAL_PCT_NUMERATOR,
  MatchGroupInput,
  MatchGroupResult,
  ShipmentReconView,
} from './recon-freight.types';

/**
 * §4.8 reconciliation arithmetic — the pure matching core. Every rule in the
 * exhaustive expected_for_charge_type table lives here; the DB-facing
 * processing service only loads rows/tariffs and persists what this returns.
 *
 * Flags are independent booleans per (AWB, charge_type) group (A2-05):
 * same-type rows for one AWB are summed BEFORE comparison, and an
 * uncomputable expectation is flag_review — never a false amount mismatch
 * and never a dropped row (INV-20).
 */

/** abs(invoiced + linked adjustments − expected) > tolerance (§4.8, RW-24). */
export function amountMismatch(
  invoicedTotal: Paise,
  adjustmentTotal: Paise,
  expected: Paise,
  tolerance: Paise,
): boolean {
  const diff = invoicedTotal + adjustmentTotal - expected;
  const abs = diff < 0n ? -diff : diff;
  return abs > tolerance;
}

/**
 * F-14 (§4.8, A3-05) and the §3.28 state. matched = Σ invoiced over rows
 * that matched cleanly; review = Σ over flag_review / flag_awb_not_found
 * rows. MISMATCH when |residual| > max(S-19 ₹100.00, S-20 0.5% × declared).
 */
export function controlTotal(
  declared: Paise,
  matched: Paise,
  review: Paise,
): { residual: Paise; state: 'WITHIN_THRESHOLD' | 'MISMATCH' } {
  const residual = declared - matched - review;
  const pctThreshold = (declared * CONTROL_TOTAL_PCT_NUMERATOR) / CONTROL_TOTAL_PCT_DENOMINATOR;
  const threshold =
    pctThreshold > CONTROL_TOTAL_FLOOR_PAISE ? pctThreshold : CONTROL_TOTAL_FLOOR_PAISE;
  const abs = residual < 0n ? -residual : residual;
  return { residual, state: abs > threshold ? 'MISMATCH' : 'WITHIN_THRESHOLD' };
}

/** §4.8 FORWARD: F-23 via the snapshot's immutable tariff (INV-8/INV-11). */
function forwardExpectation(
  shipment: ShipmentReconView,
  tariff: TariffInput | null,
  invoicedWeightKg: string | null,
): { expected: string | null; audited: string | null; review: boolean } {
  const basis = shipment.expectedCostBasis;
  // §4.8 table: NONE → no expectation, flag_review (§4.5: expected null
  // exactly here). PROVIDER_CONFIRMED_CHARGE → the confirmed charge.
  if (basis === 'NONE') return { expected: null, audited: null, review: true };
  if (basis === 'PROVIDER_CONFIRMED_CHARGE') {
    return shipment.providerConfirmedCharge === null
      ? { expected: null, audited: null, review: true } // charge not persisted → INV-20
      : { expected: shipment.providerConfirmedCharge, audited: null, review: false };
  }

  const snapshot = shipment.snapshot;
  if (snapshot === null || snapshot.expectedQuote === null) {
    return { expected: null, audited: null, review: true };
  }

  if (snapshot.rateCardVersionId !== null && tariff !== null) {
    // F-23 = F-5…F-11 with the INVOICED billable weight substituted for F-3
    // (absent invoiced weight ⇒ the booked F-3, i.e. the frozen quote).
    const billable = invoicedWeightKg ?? snapshot.weights.billableWeightKg;
    if (billable === null) return { expected: null, audited: null, review: true };
    const result = auditedQuote(tariff, {
      zone: snapshot.zone as ZoneCode | null,
      billableWeightKg: billable,
      paymentMode: snapshot.payment.mode,
      collectible: snapshot.payment.collectible,
      declaredValue: snapshot.formulaInputs.declaredValue,
    });
    if (!result.priceable) {
      // §4.1 zero/null guard on a sealed card — unpriceable, flag_review.
      return { expected: null, audited: null, review: true };
    }
    return {
      expected: result.breakdown.f11Total,
      audited: result.breakdown.f11Total,
      review: false,
    };
  }

  // LIVE_QUOTE snapshot: the provider's tariff is opaque — no weight-based
  // recompute exists, so the frozen quote total is the expectation and
  // audited_amount stays null (F-23 is defined over rate-card terms only).
  return { expected: snapshot.expectedQuote.total, audited: null, review: false };
}

/** §4.8 RTO: F-12 recomputed on the invoiced weight; no rto_rule ⇒ review. */
function rtoExpectation(
  shipment: ShipmentReconView,
  tariff: TariffInput | null,
  invoicedWeightKg: string | null,
): { expected: string | null; review: boolean } {
  const snapshot = shipment.snapshot;
  const rtoRule = snapshot?.expectedQuote?.rtoRule ?? null;
  if (snapshot === null || snapshot.expectedQuote === null || rtoRule === null) {
    return { expected: null, review: true }; // §4.4: no rto_rule → flag_review
  }
  const billable = invoicedWeightKg ?? snapshot.weights.billableWeightKg;
  if (billable === null) return { expected: null, review: true };

  if (snapshot.rateCardVersionId !== null && tariff !== null) {
    const f5 = snapshot.expectedQuote.components.find((c) => c.code === 'F-5');
    if (!f5) return { expected: null, review: true };
    const result = computeRtoExpectation({
      rtoRule,
      snapshot: {
        f5BaseFreight: f5.amount,
        billableWeightKg: billable, // §4.8: F-12 recomputed on invoiced weight
        declaredValue: snapshot.formulaInputs.declaredValue,
      },
      tariff,
    });
    return result.kind === 'EXPECTED'
      ? { expected: result.breakdown.f11Total, review: false }
      : { expected: null, review: true };
  }

  // LIVE_QUOTE: interpret the rto_rule identically over the frozen quote
  // total (§4.4) — the provider's component terms are opaque, so the rto
  // base is the total itself.
  const total = rupeesToPaise(snapshot.expectedQuote.total);
  if (rtoRule.basis === 'SAME_AS_FORWARD') {
    return { expected: paiseToRupees(total), review: false };
  }
  if (rtoRule.pct === null) return { expected: null, review: true };
  return {
    expected: paiseToRupees(applyRate(total, rateToMillionths(rtoRule.pct))),
    review: false,
  };
}

/**
 * The §4.8 per-group evaluation. Weight mismatch is NOT computed here — it
 * is per-row (weights never sum) via `weightMismatch` in the types file.
 */
export function matchGroup(
  input: MatchGroupInput & { tariff: TariffInput | null; invoicedWeightKg: string | null },
): MatchGroupResult {
  const { shipment } = input;

  // flag_awb_not_found — no Shipment in this Shop (INV-20: the row is
  // stored and surfaced; nothing else is computable).
  if (shipment === null) {
    return {
      flagAwbNotFound: true,
      flagAmountMismatch: false,
      flagReview: input.chargeTypeUnmapped,
      expectedAmount: null,
      auditedAmount: null,
    };
  }

  let expected: string | null = null;
  let audited: string | null = null;
  let review = input.chargeTypeUnmapped;

  switch (input.chargeType) {
    case 'FORWARD': {
      const r = forwardExpectation(shipment, input.tariff, input.invoicedWeightKg);
      expected = r.expected;
      audited = r.audited;
      review = review || r.review;
      break;
    }
    case 'RTO': {
      const r = rtoExpectation(shipment, input.tariff, input.invoicedWeightKg);
      expected = r.expected;
      review = review || r.review;
      break;
    }
    case 'COD_FEE': {
      // §4.8: the snapshot's F-7; unquoted snapshot → flag_review.
      const f7 = shipment.snapshot?.expectedQuote?.components.find((c) => c.code === 'F-7');
      if (f7) {
        expected = f7.amount;
      } else {
        review = true;
      }
      break;
    }
    case 'REATTEMPT':
    case 'OTHER':
      // §4.8 (A2-05): no expectation — flag_review, never a false mismatch.
      review = true;
      break;
    case 'ADJUSTMENT':
      // Resolved by the processing service against the adjusted row (RW-24);
      // a group reaching here unidentified gets flag_review.
      review = true;
      break;
  }

  // §4.1: only ADJUSTMENT rows may be signed — a negative amount on any
  // other charge type is surfaced for review, never silently compared.
  if (
    input.chargeType !== 'ADJUSTMENT' &&
    input.invoicedAmountTotal !== null &&
    input.invoicedAmountTotal < 0n
  ) {
    review = true;
  }

  const flagAmountMismatch =
    expected !== null && input.invoicedAmountTotal !== null
      ? amountMismatch(
          input.invoicedAmountTotal,
          input.adjustmentTotal,
          rupeesToPaise(expected),
          input.freightTolerance,
        )
      : false;

  // A row whose amount could not be parsed at all is reviewed (INV-20).
  if (input.invoicedAmountTotal === null) review = true;

  return {
    flagAwbNotFound: false,
    flagAmountMismatch,
    flagReview: review,
    expectedAmount: expected,
    auditedAmount: audited,
  };
}
