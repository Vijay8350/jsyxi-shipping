import {
  ShipmentWorkingValues,
  WorkingPayment,
  WorkingRecipient,
} from '../order-sync/working-values.types';
import { DeadWeightLineResult } from './weight';
import { EligibilityCheck } from './eligibility';
import { PackageSelectionSource } from './package-selection';
import { PaymentMode } from './payment';

/**
 * Week-4 additive extensions to shipment.working_values (§2.9). The base
 * shape's contract is "extend it, never restructure it" — these blocks land
 * as NEW optional members and the payment block's placeholders are filled
 * in place (mode widens from its 'UNRESOLVED' placeholder to the derived
 * §3.5 value; collectible becomes F-15).
 *
 * NOTE for the parent: order-sync's WorkingPayment declares
 * `mode: 'UNRESOLVED'` as a placeholder literal. Widening it to the full
 * PaymentMode union is a one-line shared change to
 * src/modules/order-sync/working-values.types.ts, flagged in the handoff;
 * until then this module writes through WorkingPaymentWeek4.
 */

/** §3.5 derivation result written over the ingest-time placeholder. */
export interface WorkingPaymentWeek4 extends Omit<WorkingPayment, 'mode'> {
  mode: PaymentMode;
  /** F-15 (§4.6), 2dp NUMERIC text — the Collectible the carrying Shipment books with (§4.7). */
  collectible: string;
}

/** F-24 block (§4.2): the dead weight with its per-line derivation (§2.9). */
export interface WorkingWeight {
  deadWeightKg: string;
  lineWeightTotalKg: string;
  tareKg: string;
  /** True when S-7 was substituted (§4.2 step 3). */
  usedDefaultParcelWeight: boolean;
  lines: DeadWeightLineResult[];
}

/** F-20 block (§4.9): the resolved package profile. */
export interface WorkingPackageProfile {
  packageProfileId: string;
  source: PackageSelectionSource;
  matchedRuleId: string | null;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  tareKg: string;
}

/** INV-7 evaluation (§9.2.4): the failing hard-blocks for the UI. */
export interface WorkingValidation {
  ready: boolean;
  failures: EligibilityCheck[];
  /** ISO timestamp of the evaluation. */
  evaluatedAt: string;
}

/** §9.4.4 routing block (weeks 9–11): written by RuleRoutingService when a
 *  rule selects the Service — feeds the snapshot's rule_id/rule_version (§2.9). */
export interface WorkingRouting {
  ruleId: string | null;
  ruleVersion: number | null;
  serviceId: string;
  traceId: string;
  fallbackChain: string | null;
  evaluatedAt: string;
}

export interface ShipmentWorkingValuesWeek4
  extends Omit<ShipmentWorkingValues, 'payment' | 'recipient'> {
  recipient: WorkingRecipient | null;
  payment: WorkingPaymentWeek4;
  weight?: WorkingWeight;
  packageProfile?: WorkingPackageProfile;
  validation?: WorkingValidation;
  routing?: WorkingRouting;
}
