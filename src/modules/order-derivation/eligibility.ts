import { kgToGrams } from './weight';
import { PaymentMode } from './payment';
import { rupeesToPaise } from '../../common/money';

/**
 * INV-7 booking hard-blocks (§3.1, §9.2.1, §9.2.4) — pure evaluation.
 *
 * Every condition is evaluable from data that exists at sync time (INV-7):
 * the recipient snapshot, the allocated lines, F-24 + the resolved package
 * profile's dimensions, the pickup location and the §3.5 payment mode with
 * its Collectible. Sync RETAINS incomplete orders; only booking blocks — so
 * this evaluation drives IMPORTED → INCOMPLETE ↔ READY (§3.1), and the
 * failing checks are returned so the UI can show them (§9.2.4).
 *
 * The Service/credentials blocks are later-module concerns (weeks 4–6 courier
 * module owns merchant_service, serviceability and courier_account
 * credentials): they are named checks that currently PASS — see the TODOs.
 */

export type EligibilityCheck =
  | 'RECIPIENT_NAME'
  | 'RECIPIENT_ADDRESS'
  | 'RECIPIENT_PINCODE'
  | 'RECIPIENT_PHONE'
  | 'ALLOCATED_LINES'
  | 'POSITIVE_WEIGHT'
  | 'POSITIVE_DIMENSIONS'
  | 'PICKUP_LOCATION'
  | 'PAYMENT_MODE'
  | 'COLLECTIBLE'
  | 'SERVICE_SERVICEABLE'
  | 'COURIER_CREDENTIALS';

export interface EligibilityRecipient {
  name: string | null;
  addressLines: string[];
  pincode: string | null;
  phone: string | null;
}

export interface EligibilityInput {
  recipient: EligibilityRecipient | null;
  /** Allocated lines with positive quantity (INV-7). */
  allocatedLineCount: number;
  /** F-24, NUMERIC(10,3) kg text; null when not derivable. */
  deadWeightKg: string | null;
  /** Resolved package profile dimensions, NUMERIC(10,2) cm text. */
  dimensionsCm: { lengthCm: string; widthCm: string; heightCm: string } | null;
  pickupLocationId: string | null;
  paymentMode: PaymentMode;
  /** The Collectible (F-15 on the carrying shipment), NUMERIC text. */
  collectible: string | null;
}

export interface EligibilityResult {
  ready: boolean;
  /** Failing check codes, in INV-7 order — shown on the order (§9.2.4). */
  failures: EligibilityCheck[];
}

function nonBlank(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim() !== '';
}

/** INV-7: 6-digit Indian destination pincode. */
function validPincode(pincode: string | null): boolean {
  return pincode !== null && /^[0-9]{6}$/.test(pincode.trim());
}

/** INV-7: 10-digit phone; +91 / leading-0 forms normalize to 10 digits. */
function validPhone(phone: string | null): boolean {
  if (phone === null) return false;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return true;
  if (digits.length === 11 && digits.startsWith('0')) return true;
  if (digits.length === 12 && digits.startsWith('91')) return true;
  return false;
}

/** NUMERIC(10,2) cm text > 0 — compared as integer hundredths, no floats. */
function positiveDimension(value: string): boolean {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return false;
  return BigInt(m[1] as string) > 0n || BigInt(((m[2] ?? '') + '00').slice(0, 2)) > 0n;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const failures: EligibilityCheck[] = [];

  // INV-7 recipient blocks (§9.2.4 flags the same fields pre-booking).
  if (!nonBlank(input.recipient?.name)) failures.push('RECIPIENT_NAME');
  if (!input.recipient || !input.recipient.addressLines.some((l) => nonBlank(l))) {
    failures.push('RECIPIENT_ADDRESS');
  }
  if (!validPincode(input.recipient?.pincode ?? null)) failures.push('RECIPIENT_PINCODE');
  if (!validPhone(input.recipient?.phone ?? null)) failures.push('RECIPIENT_PHONE');

  // INV-7: allocated lines with positive quantity.
  if (input.allocatedLineCount <= 0) failures.push('ALLOCATED_LINES');

  // INV-7: positive F-24 parcel weight and positive dimensions.
  if (input.deadWeightKg === null || kgToGrams(input.deadWeightKg) <= 0n) {
    failures.push('POSITIVE_WEIGHT');
  }
  if (
    input.dimensionsCm === null ||
    !positiveDimension(input.dimensionsCm.lengthCm) ||
    !positiveDimension(input.dimensionsCm.widthCm) ||
    !positiveDimension(input.dimensionsCm.heightCm)
  ) {
    failures.push('POSITIVE_DIMENSIONS');
  }

  // INV-7: pickup location (INV-3's single active location, mirrored on the shipment).
  if (input.pickupLocationId === null) failures.push('PICKUP_LOCATION');

  // INV-7: resolved payment mode and Collectible (§3.5, §4.7).
  if (input.paymentMode === 'UNRESOLVED') failures.push('PAYMENT_MODE');
  if (input.collectible === null || rupeesToPaise(input.collectible) < 0n) {
    failures.push('COLLECTIBLE');
  }

  // TODO(weeks 4–6 courier module): INV-7's "an enabled, serviceable Service"
  // check — passes until merchant_service / routing exists.
  const serviceServiceable = true;
  if (!serviceServiceable) failures.push('SERVICE_SERVICEABLE');
  // TODO(weeks 4–6 courier module): INV-7's "valid courier credentials for
  // the account's current mode" check — passes until courier_account exists.
  const courierCredentialsValid = true;
  if (!courierCredentialsValid) failures.push('COURIER_CREDENTIALS');

  return { ready: failures.length === 0, failures };
}
