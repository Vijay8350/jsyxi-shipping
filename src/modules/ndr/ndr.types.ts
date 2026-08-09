/**
 * NDR suite types (§2.5, §3.10 machine F, §9.8). Value lists mirror the spec
 * enums verbatim (RV-07); the PG enums live in migration 0014.
 */

import type { MovementState } from '../tracking/tracking.types';

/** §3.10 NDR_REASON — the five normalized values. */
export type NdrReason =
  | 'CUSTOMER_REFUSED'
  | 'UNCONTACTABLE'
  | 'ADDRESS_ISSUE'
  | 'COD_NOT_READY'
  | 'OTHER';

/** §3.10 NDR_ACTION (identical to the adapter contract's NdrActionType). */
export type NdrAction = 'REATTEMPT' | 'UPDATE_ADDRESS_AND_REATTEMPT' | 'INITIATE_RTO';

/** §3.10 NDR_CASE_STATE. */
export type NdrCaseState =
  | 'OPEN'
  | 'ACTION_SUBMITTED'
  | 'REATTEMPT_SCHEDULED'
  | 'RTO_REQUESTED'
  | 'CLOSED';

/** ADD-27 buyer self-serve response types (migration 0014 CHECK constraint). */
export type NdrBuyerResponseType =
  | 'CONFIRM_ADDRESS'
  | 'CORRECT_ADDRESS'
  | 'CHOOSE_REATTEMPT_DATE'
  | 'COD_TO_PREPAID';

/** S-42 digest frequencies (migration 0014 CHECK constraint). */
export type NdrDigestFrequency = 'hourly' | 'daily' | 'weekly';

/** S-42 alert channels (migration 0014 ndr_settings.channel, lowercase). */
export type NdrAlertChannel = 'email' | 'sms' | 'whatsapp';

/** S-44 default: the auto-RTO warning fires 48h after the first NDR (RW-05). */
export const AUTO_RTO_WARN_HOURS = 48;

/** §3.4 terminal MOVEMENT_STATE values — reaching one CLOSES the case (§3.10). */
export const TERMINAL_MOVEMENT_STATES: readonly MovementState[] = [
  'DELIVERED',
  'RTO_DELIVERED',
  'LOST_OR_DAMAGED',
  'CANCELLED_BY_COURIER',
];

/**
 * §3.10 reason normalization: the courier event's free-text reason_text is
 * folded into the five NDR_REASON values. An unmappable reason is NEVER
 * discarded — it lands in OTHER and the raw text stays on tracking_event
 * (RV-14, INV-20). Keyword order is significant: COD and refusal are checked
 * before the looser address/contact families.
 */
export function normalizeNdrReason(reasonText: string | null | undefined): NdrReason {
  if (!reasonText) return 'OTHER';
  const t = reasonText.toLowerCase();
  if (/\bcod\b|cash on delivery|payment not ready|amount not ready|cash not ready|no cash/.test(t)) {
    return 'COD_NOT_READY';
  }
  if (/refus|declin|not accept|reject/.test(t)) {
    return 'CUSTOMER_REFUSED';
  }
  if (/address|incomplete|landmark|pin\s?code|wrong location|not traceable|house|door|flat|locate/.test(t)) {
    return 'ADDRESS_ISSUE';
  }
  if (/uncontact|not reachable|no response|no answer|unavailable|switched off|not picking|phone|call/.test(t)) {
    return 'UNCONTACTABLE';
  }
  return 'OTHER';
}

export interface NdrCaseRow {
  ndr_case_id: string;
  shop_id: string;
  shipment_id: string;
  attempt_count: number;
  reason_code: NdrReason;
  first_ndr_at: string;
  last_ndr_at: string;
  state: NdrCaseState;
  auto_rto_warn_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface NdrActionRow {
  ndr_action_id: string;
  ndr_case_id: string;
  action: NdrAction;
  actor_member_id: string | null;
  payload: Record<string, unknown>;
  submitted_at: string;
  provider_ack: string | null;
  result: string | null;
  created_at: string;
}

export interface NdrSettingsRow {
  shop_id: string;
  recipients: string[]; // S-41
  channel: NdrAlertChannel; // S-42
  digest_frequency: NdrDigestFrequency; // S-42
  auto_reattempt_once: boolean; // S-43
  escalation_templates: unknown[];
  version: number;
}

export interface NdrBuyerResponseRow {
  response_id: string;
  shop_id: string;
  ndr_case_id: string;
  response_type: NdrBuyerResponseType;
  payload: Record<string, unknown>;
  ndr_action_id: string | null;
  created_at: string;
}
