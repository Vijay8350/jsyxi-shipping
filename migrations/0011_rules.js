/**
 * 0011 — weeks 9–11 schema: shipping rules v2 (§2.4 rule*, §3.8, §3.9)
 * with Addendum C1: condition groups (ADD-13), MANUAL_ONLY (ADD-14),
 * excluded services (ADD-15), scheduling (ADD-16), and the extended
 * condition field/operator lists (§3.9 + ADD-01…ADD-12).
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §3.8 RULE_ACTION_TYPE + MANUAL_ONLY (ADD-14)
    CREATE TYPE rule_action_type AS ENUM (
      'PRIORITY_CHAIN', 'CHEAPEST', 'FASTEST', 'MANUAL_ONLY'
    );

    -- §3.9 RULE_CONDITION_FIELD + ADD-01…ADD-12
    CREATE TYPE rule_condition_field AS ENUM (
      'WEIGHT', 'ORDER_AMOUNT', 'PAYMENT_MODE', 'PINCODE', 'SKU', 'TAG',
      'DEST_STATE', 'DEST_CITY', 'ZONE', 'COD_AMOUNT', 'ESTIMATED_FREIGHT',
      'CHECKOUT_SHIPPING_TITLE', 'CHECKOUT_SHIPPING_AMOUNT', 'ITEM_COUNT',
      'PRODUCT', 'VENDOR', 'COLLECTION', 'VOLUMETRIC_WEIGHT', 'RISK_FLAG',
      'WEEKDAY', 'TIME_OF_DAY'
    );

    -- §3.9 OPERATOR + the operators the ADD fields introduce
    CREATE TYPE rule_operator AS ENUM (
      'EQUALS', 'BETWEEN', 'GTE', 'LTE', 'IN_LIST', 'NOT_IN_LIST',
      'IN_SAVED_ZONE', 'CSV_UPLOAD', 'IS_COD', 'IS_PREPAID', 'CONTAINS',
      'IS_HIGH', 'IS_NOT_HIGH'
    );

    CREATE TABLE rule (
      rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      name text NOT NULL,
      -- §9.4.1: the warehouse-scope column remains, populated with the
      -- single pickup location (A4-02); no picker in the v1 UI.
      pickup_location_id uuid REFERENCES pickup_location (pickup_location_id),
      is_active boolean NOT NULL DEFAULT true,
      position integer NOT NULL,
      action_type rule_action_type NOT NULL,
      -- ADD-15: eliminated before the action's own rule (§4.5), with its
      -- own trace reason.
      excluded_service_ids uuid[] NOT NULL DEFAULT '{}',
      -- ADD-16: optional scheduling window, evaluated in shop-local time;
      -- outside the window the rule is skipped (trace: skipped-by-schedule).
      active_from timestamptz,
      active_to timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX rule_shop_position ON rule (shop_id, position);

    -- ADD-13: one level of grouping — conditions AND within a group, groups
    -- OR between. No arbitrary nesting.
    CREATE TABLE rule_condition_group (
      group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id uuid NOT NULL REFERENCES rule (rule_id) ON DELETE CASCADE,
      position integer NOT NULL
    );

    CREATE TABLE rule_condition (
      condition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id uuid NOT NULL REFERENCES rule (rule_id) ON DELETE CASCADE,
      group_id uuid NOT NULL REFERENCES rule_condition_group (group_id) ON DELETE CASCADE,
      field rule_condition_field NOT NULL,
      operator rule_operator NOT NULL,
      value_json jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- The action's ordered Service chain (PRIORITY_CHAIN order; the
    -- candidate set for CHEAPEST / FASTEST).
    CREATE TABLE rule_action_service (
      action_service_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id uuid NOT NULL REFERENCES rule (rule_id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES service (service_id),
      position integer NOT NULL
    );

    CREATE TABLE saved_zone (
      saved_zone_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      name text NOT NULL,
      pincodes text[] NOT NULL DEFAULT '{}',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, name)
    );

    -- §9.4.5 (A1-03, RV-03): every evaluation persists the matched rule and
    -- version, per-condition results, skipped rules with the failing
    -- condition (and ADD-16 skipped-by-schedule), per-candidate results with
    -- cost/EDD/quote timestamps and structured elimination reasons, the
    -- selected service and the fallback chain used.
    CREATE TABLE rule_evaluation_trace (
      trace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shipment_id uuid NOT NULL,
      rule_id uuid,
      rule_version integer,
      condition_results jsonb NOT NULL,
      candidate_results jsonb NOT NULL,
      selected_service_id uuid,
      fallback_chain jsonb,
      evaluated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX rule_trace_shipment ON rule_evaluation_trace (shipment_id, evaluated_at);

    CREATE TRIGGER t BEFORE UPDATE ON rule FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON saved_zone FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      rule, rule_condition_group, rule_condition, rule_action_service,
      saved_zone, rule_evaluation_trace
      TO jsyxi_app;
    GRANT USAGE ON TYPE
      rule_action_type, rule_condition_field, rule_operator
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS rule_evaluation_trace, saved_zone,
      rule_action_service, rule_condition, rule_condition_group, rule;
    DROP TYPE IF EXISTS rule_operator, rule_condition_field, rule_action_type;
  `);
};
