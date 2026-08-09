/**
 * Row and view types for the rules module (§2.4 rule*, §9.4). Evaluation
 * types live in evaluate.ts (the pure core); these are the DB-bound shapes.
 */

import type {
  RuleActionType,
  RuleConditionField,
  RuleOperator,
  ConditionValue,
} from './evaluate';

export interface RuleRow {
  rule_id: string;
  shop_id: string;
  name: string;
  pickup_location_id: string | null;
  is_active: boolean;
  position: number;
  action_type: RuleActionType;
  excluded_service_ids: string[];
  active_from: string | null;
  active_to: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RuleConditionGroupRow {
  group_id: string;
  rule_id: string;
  position: number;
}

export interface RuleConditionRow {
  condition_id: string;
  rule_id: string;
  group_id: string;
  field: RuleConditionField;
  operator: RuleOperator;
  value_json: ConditionValue;
}

export interface RuleActionServiceRow {
  action_service_id: string;
  rule_id: string;
  service_id: string;
  position: number;
}

export interface SavedZoneRow {
  saved_zone_id: string;
  shop_id: string;
  name: string;
  pincodes: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RuleEvaluationTraceRow {
  trace_id: string;
  shop_id: string;
  shipment_id: string;
  rule_id: string | null;
  rule_version: number | null;
  condition_results: unknown;
  candidate_results: unknown;
  selected_service_id: string | null;
  fallback_chain: unknown;
  evaluated_at: string;
}

/** A rule with its children, as the API and the loader read it. */
export interface RuleView {
  ruleId: string;
  name: string;
  isActive: boolean;
  position: number;
  actionType: RuleActionType;
  excludedServiceIds: string[];
  activeFrom: string | null;
  activeTo: string | null;
  version: number;
  groups: {
    groupId: string;
    position: number;
    conditions: {
      conditionId: string;
      field: RuleConditionField;
      operator: RuleOperator;
      value: ConditionValue;
    }[];
  }[];
  actionServiceIds: string[];
}
