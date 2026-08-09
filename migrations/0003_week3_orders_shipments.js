/**
 * 0003 — weeks 3–4 schema: locations, packages, postal master (§2.3) and
 * orders, shipments & routing core (§2.4), plus Addendum A columns
 * (ADD-06/07 checkout shipping fields, ADD-39 order.source, ADD-14's new
 * §3.30 value HELD_BY_RULE).
 *
 * DB-level guards (Addendum A working rules):
 * - INV-3  exactly one active pickup_location per Shop — unique partial index
 * - INV-24 exactly one default package_profile per Shop — unique partial
 *          index; the default row cannot be deleted (trigger), only replaced
 *          by promoting another profile in the same transaction (RW-21)
 * - INV-9  one collectible-bearing shipment per order — trigger; the booking
 *          transaction holds a row lock on the order (§4.7 names "a row-level
 *          lock or a unique partial index" — on a partitioned table the lock
 *          is the available mechanism)
 * - INV-10 snapshot write-once — trigger allowing change only at DRAFT→QUEUED
 *          (initial freeze and the §2.9 re-freeze on a new attempt)
 * - INV-19 is_test immutable after insert — trigger
 * - §10.4  working values editable only while DRAFT / NEEDS_MANUAL_ASSIGNMENT
 *
 * Partitioning (§5.1): shipment is RANGE-partitioned monthly on created_at
 * (booked_at is nullable pre-booking, so it cannot be the key). PG requires
 * the partition key in every unique index, so INV-6 AWB uniqueness is
 * enforced by the booking transaction under an advisory lock keyed on
 * (courier_account_id, awb_normalized) — plan ambiguity A-7, accepted.
 */

exports.up = (pgm) => {
  pgm.sql(`
    --------------------------------------------------------------------
    -- Enum types (spec.md §3 value lists, verbatim; RV-07).
    --------------------------------------------------------------------

    -- §3.1 ORDER_STATE
    CREATE TYPE order_state AS ENUM (
      'IMPORTED', 'INCOMPLETE', 'READY', 'PARTIALLY_BOOKED',
      'FULLY_BOOKED', 'CLOSED', 'CANCELLED_IN_SHOPIFY'
    );

    -- §3.5 PAYMENT_MODE
    CREATE TYPE payment_mode AS ENUM ('PREPAID', 'COD', 'UNRESOLVED');

    -- §3.24 COD_ASSIGNMENT_STATE
    CREATE TYPE cod_assignment_state AS ENUM (
      'NOT_APPLICABLE', 'ASSIGNED', 'UNASSIGNED'
    );

    -- §3.22 ALLOCATION_STATE
    CREATE TYPE allocation_state AS ENUM (
      'OPEN', 'PARTIALLY_BOOKED', 'FULLY_BOOKED', 'EXCLUDED', 'CLOSED'
    );

    -- §3.2 BOOKING_STATE
    CREATE TYPE booking_state AS ENUM (
      'DRAFT', 'NEEDS_MANUAL_ASSIGNMENT', 'QUEUED', 'SUBMITTED',
      'CONFIRMED', 'FAILED', 'OUTCOME_UNKNOWN', 'VOID'
    );

    -- §3.30 MANUAL_ASSIGNMENT_REASON + HELD_BY_RULE (ADD-14)
    CREATE TYPE manual_assignment_reason AS ENUM (
      'CHAIN_EXHAUSTED', 'NO_SERVICEABLE_CANDIDATE',
      'NO_RULE_AND_NO_DEFAULT_CHAIN', 'PAYMENT_MODE_UNRESOLVED',
      'HELD_BY_RULE'
    );

    -- §3.3 CUSTODY_STATE
    CREATE TYPE custody_state AS ENUM (
      'NOT_APPLICABLE', 'PICKUP_PENDING', 'PICKUP_SCHEDULED', 'IN_CUSTODY',
      'CANCEL_REQUESTED', 'CANCELLED', 'CANCEL_REJECTED'
    );

    -- §3.4 MOVEMENT_STATE
    CREATE TYPE movement_state AS ENUM (
      'NOT_SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'NDR', 'DELIVERED',
      'RTO_INITIATED', 'RTO_IN_TRANSIT', 'RTO_OUT_FOR_DELIVERY',
      'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER'
    );

    -- §3.25 EXPECTED_COST_BASIS
    CREATE TYPE expected_cost_basis AS ENUM (
      'SNAPSHOT_QUOTE', 'PROVIDER_CONFIRMED_CHARGE', 'NONE'
    );

    -- §3.23 BOOKING_INTENT_OUTCOME
    CREATE TYPE booking_intent_outcome AS ENUM (
      'IN_FLIGHT', 'CONFIRMED', 'FAILED', 'UNKNOWN',
      'RESOLVED_CONFIRMED', 'RESOLVED_FAILED'
    );

    -- ADD-39: orders not originating in Shopify.
    CREATE TYPE order_source AS ENUM ('SHOPIFY', 'MANUAL');

    --------------------------------------------------------------------
    -- §2.3 Locations, packages & pricing reference
    --------------------------------------------------------------------

    CREATE TABLE pickup_location (
      pickup_location_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      name text NOT NULL,
      contact_name text,
      phone text,
      address_lines text[] NOT NULL DEFAULT '{}',
      city text,
      -- free text validated against the postal master — the one geographic
      -- "state" column that is not a status enum (§2 enum completeness rule)
      state text,
      pincode text CHECK (pincode ~ '^[0-9]{6}$'),
      gstin text,
      is_active boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- INV-3: exactly one active pickup location per Shop at v1.
    CREATE UNIQUE INDEX pickup_location_one_active
      ON pickup_location (shop_id) WHERE is_active;

    CREATE TABLE shopify_location (
      shopify_location_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shopify_location_gid text NOT NULL,
      name text NOT NULL,
      ships_via_jsyxi boolean NOT NULL DEFAULT true,     -- §9.2.3, RW-14
      discovered_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, shopify_location_gid)
    );

    CREATE TABLE package_profile (
      package_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      name text NOT NULL,
      length_cm numeric(10,2) NOT NULL CHECK (length_cm > 0),
      width_cm numeric(10,2) NOT NULL CHECK (width_cm > 0),
      height_cm numeric(10,2) NOT NULL CHECK (height_cm > 0),
      tare_kg numeric(10,3) NOT NULL DEFAULT 0 CHECK (tare_kg >= 0),
      is_default boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- INV-24: exactly one default package profile per Shop (RW-21).
    CREATE UNIQUE INDEX package_profile_one_default
      ON package_profile (shop_id) WHERE is_default;

    -- INV-24: the default profile cannot be deleted, only replaced by
    -- promoting another profile in the same transaction (unset old, set new).
    CREATE OR REPLACE FUNCTION guard_default_package_profile_delete()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.is_default THEN
        RAISE EXCEPTION 'INV-24: the default package profile cannot be deleted; promote another profile first';
      END IF;
      RETURN OLD;
    END;
    $fn$;
    CREATE TRIGGER default_profile_delete_guard
      BEFORE DELETE ON package_profile
      FOR EACH ROW EXECUTE FUNCTION guard_default_package_profile_delete();

    CREATE TABLE package_selection_rule (
      package_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      position integer NOT NULL,
      min_dead_kg numeric(10,3),
      max_dead_kg numeric(10,3),
      min_items integer,
      max_items integer,
      package_profile_id uuid NOT NULL REFERENCES package_profile (package_profile_id),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE sku_override (
      sku_override_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      sku text NOT NULL,                       -- normalized per RW-13 before write
      weight_kg numeric(10,3) CHECK (weight_kg >= 0),   -- per UNIT (RW-14)
      package_profile_id uuid REFERENCES package_profile (package_profile_id),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, sku)
    );

    CREATE TABLE postal_zone_master_version (                -- [global]
      postal_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label text NOT NULL,
      effective_from date NOT NULL,
      published_at timestamptz,
      row_count integer CHECK (row_count >= 0)
    );

    CREATE TABLE postal_pincode (                            -- [global]
      postal_pincode_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      postal_version_id uuid NOT NULL
        REFERENCES postal_zone_master_version (postal_version_id),
      pincode text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
      city text,
      district text,
      state text,          -- geographic state, not a status enum (§2 rule)
      region text,
      is_metro boolean NOT NULL DEFAULT false,
      is_special boolean NOT NULL DEFAULT false,
      UNIQUE (postal_version_id, pincode)
    );
    CREATE INDEX postal_pincode_lookup ON postal_pincode (pincode);

    --------------------------------------------------------------------
    -- §2.4 Orders, shipments & routing (core)
    --------------------------------------------------------------------

    CREATE TABLE "order" (
      order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shopify_order_gid text,                 -- null for ADD-39 manual orders
      shopify_order_number text,
      created_at_shopify timestamptz,
      order_state order_state NOT NULL DEFAULT 'IMPORTED',
      payment_mode payment_mode NOT NULL DEFAULT 'UNRESOLVED',
      cod_assignment_state cod_assignment_state NOT NULL DEFAULT 'NOT_APPLICABLE',
      order_amount numeric(19,4) CHECK (order_amount >= 0),        -- F-17
      cod_outstanding numeric(19,4) CHECK (cod_outstanding >= 0),  -- F-15
      shop_currency text NOT NULL DEFAULT 'INR' CHECK (shop_currency = 'INR'),
      presentment_amount numeric(19,4),       -- display only (A2-04)
      presentment_currency text,
      recipient_snapshot jsonb,               -- RV-13 protected fields
      risk_flag text,                         -- §8.1: where present, else null
      is_test_order boolean NOT NULL DEFAULT false,
      checkout_shipping_title text,           -- ADD-06
      checkout_shipping_amount numeric(19,4) CHECK (checkout_shipping_amount >= 0),  -- ADD-07
      source order_source NOT NULL DEFAULT 'SHOPIFY',               -- ADD-39
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX order_shopify_gid_key
      ON "order" (shop_id, shopify_order_gid)
      WHERE shopify_order_gid IS NOT NULL;
    CREATE INDEX order_shop_state ON "order" (shop_id, order_state);

    CREATE TABLE order_line (
      order_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES "order" (order_id),
      shopify_line_gid text,
      sku text,
      title text,
      variant text,
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_price numeric(19,4) CHECK (unit_price >= 0),
      tags text[] NOT NULL DEFAULT '{}',
      hsn_code text,                          -- nullable (§8.1)
      weight_kg_override numeric(10,3) CHECK (weight_kg_override >= 0),  -- per UNIT (RV-02)
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX order_line_order ON order_line (order_id);

    CREATE TABLE allocation (
      allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES "order" (order_id),
      pickup_location_id uuid REFERENCES pickup_location (pickup_location_id),
      source_fulfillment_order_gids text[] NOT NULL DEFAULT '{}',
      state allocation_state NOT NULL DEFAULT 'OPEN',
      created_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX allocation_order ON allocation (order_id);

    -- Partitioned by month on created_at (§5.1; booked_at is nullable
    -- pre-booking so it cannot be the partition key).
    CREATE TABLE shipment (
      shipment_id uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      order_id uuid NOT NULL REFERENCES "order" (order_id),
      allocation_id uuid REFERENCES allocation (allocation_id),
      pickup_location_id uuid REFERENCES pickup_location (pickup_location_id),
      service_id uuid,                  -- FK added with the courier module (weeks 4–6)
      service_version_id uuid,
      courier_account_id uuid,
      awb_normalized text,              -- F-19 before any write
      awb_raw text,
      booking_state booking_state NOT NULL DEFAULT 'DRAFT',
      manual_assignment_reason manual_assignment_reason,  -- non-null only in NEEDS_MANUAL_ASSIGNMENT (§3.30)
      custody_state custody_state NOT NULL DEFAULT 'NOT_APPLICABLE',
      movement_state movement_state NOT NULL DEFAULT 'NOT_SHIPPED',
      expected_cost_basis expected_cost_basis,
      collectible numeric(19,4) NOT NULL DEFAULT 0 CHECK (collectible >= 0),
      is_test boolean NOT NULL DEFAULT false,             -- INV-19, immutable
      working_values jsonb,             -- mutable while DRAFT (§2.9)
      snapshot jsonb,                   -- frozen at DRAFT→QUEUED (§2.9, INV-10)
      booked_at timestamptz,
      delivered_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (shipment_id, created_at)
    ) PARTITION BY RANGE (created_at);
    CREATE INDEX shipment_shop_order ON shipment (shop_id, order_id);
    CREATE INDEX shipment_awb_lookup ON shipment (shop_id, awb_normalized)
      WHERE awb_normalized IS NOT NULL;
    CREATE INDEX shipment_booking_state ON shipment (shop_id, booking_state);

    CREATE TABLE shipment_default PARTITION OF shipment DEFAULT;

    -- Monthly partitions. New ones are added by create_shipment_partition()
    -- (called by a scheduled maintenance job; pre-created through 2027-06).
    CREATE OR REPLACE FUNCTION create_shipment_partition(p_year int, p_month int)
    RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE
      start_date date := make_date(p_year, p_month, 1);
      end_date date := make_date(p_year, p_month, 1) + interval '1 month';
      part_name text := format('shipment_%s_%s', p_year, lpad(p_month::text, 2, '0'));
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF shipment FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date
      );
    END;
    $fn$;
    SELECT create_shipment_partition(y, m)
      FROM generate_series(2026, 2027) AS y,
           generate_series(1, 12) AS m
      WHERE (y = 2026 AND m >= 7) OR (y = 2027 AND m <= 6);

    -- INV-10 / INV-19 / §10.4 row guards.
    CREATE OR REPLACE FUNCTION guard_shipment_row() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      -- INV-10 (RV-05): the snapshot changes only at DRAFT → QUEUED — the
      -- initial freeze, and the re-freeze on a new booking attempt (§2.9).
      IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
         AND NOT (OLD.booking_state = 'DRAFT' AND NEW.booking_state = 'QUEUED') THEN
        RAISE EXCEPTION 'INV-10: shipment.snapshot changes only at DRAFT → QUEUED';
      END IF;
      -- INV-19: set from the courier account mode at booking; immutable.
      IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
        RAISE EXCEPTION 'INV-19: shipment.is_test is immutable';
      END IF;
      -- §10.4: working values are freely editable only while DRAFT or
      -- NEEDS_MANUAL_ASSIGNMENT.
      IF NEW.working_values IS DISTINCT FROM OLD.working_values
         AND NEW.booking_state NOT IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT') THEN
        RAISE EXCEPTION '§10.4: working values are frozen from QUEUED onward';
      END IF;
      RETURN NEW;
    END;
    $fn$;
    CREATE TRIGGER shipment_row_guard
      BEFORE UPDATE ON shipment
      FOR EACH ROW EXECUTE FUNCTION guard_shipment_row();

    -- INV-9 (§4.7): at most one collectible-bearing shipment per order. The
    -- booking transaction holds a row lock on the order before this fires.
    CREATE OR REPLACE FUNCTION enforce_single_collectible() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.collectible > 0 THEN
        PERFORM 1 FROM "order" WHERE order_id = NEW.order_id FOR UPDATE;
        IF EXISTS (
          SELECT 1 FROM shipment s
           WHERE s.order_id = NEW.order_id
             AND s.shipment_id <> NEW.shipment_id
             AND s.collectible > 0
             AND s.awb_normalized IS NOT NULL
             AND s.booking_state <> 'VOID'
        ) THEN
          RAISE EXCEPTION 'INV-9: order % already has a collectible-bearing shipment with an active AWB', NEW.order_id;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$;
    CREATE TRIGGER collectible_guard
      BEFORE INSERT OR UPDATE OF collectible, awb_normalized, booking_state
      ON shipment
      FOR EACH ROW EXECUTE FUNCTION enforce_single_collectible();

    CREATE TABLE shipment_line (
      shipment_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shipment_id uuid NOT NULL,
      shipment_created_at timestamptz NOT NULL,
      order_line_id uuid NOT NULL REFERENCES order_line (order_line_id),
      quantity integer NOT NULL CHECK (quantity > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (shipment_id, shipment_created_at)
        REFERENCES shipment (shipment_id, created_at)
    );
    CREATE INDEX shipment_line_shipment ON shipment_line (shipment_id);

    -- Immutable per A1-04 except the documented outcome resolution
    -- (§3.23: IN_FLIGHT/UNKNOWN → terminal); deletes are revoked.
    CREATE TABLE booking_intent (
      booking_intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shipment_id uuid NOT NULL,
      shipment_created_at timestamptz NOT NULL,
      request_digest text NOT NULL,
      merchant_reference text NOT NULL UNIQUE,   -- §13.5: globally unique, stable across retries
      created_at timestamptz NOT NULL DEFAULT now(),
      outcome booking_intent_outcome NOT NULL DEFAULT 'IN_FLIGHT',
      resolved_at timestamptz,
      resolved_by uuid,
      FOREIGN KEY (shipment_id, shipment_created_at)
        REFERENCES shipment (shipment_id, created_at)
    );
    REVOKE DELETE ON booking_intent FROM jsyxi_app;

    CREATE TABLE track_token (
      token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shipment_id uuid NOT NULL,
      token_hash text NOT NULL UNIQUE,           -- ≥128-bit token, stored hashed (A1-07)
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );

    --------------------------------------------------------------------
    -- updated_at triggers + least-privilege grants.
    --------------------------------------------------------------------

    CREATE TRIGGER t BEFORE UPDATE ON pickup_location FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON shopify_location FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON package_profile FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON package_selection_rule FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON sku_override FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON "order" FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON order_line FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON allocation FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON shipment FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      pickup_location, shopify_location, package_profile, package_selection_rule,
      sku_override, postal_zone_master_version, postal_pincode,
      "order", order_line, allocation, shipment, shipment_line,
      track_token
      TO jsyxi_app;
    -- booking_intent resolves outcome (§3.23) but is never deleted (A1-04).
    GRANT SELECT, INSERT, UPDATE ON booking_intent TO jsyxi_app;
    GRANT USAGE ON TYPE
      order_state, payment_mode, cod_assignment_state, allocation_state,
      booking_state, manual_assignment_reason, custody_state, movement_state,
      expected_cost_basis, booking_intent_outcome, order_source
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS track_token, booking_intent, shipment_line, shipment,
      allocation, order_line, "order", postal_pincode, postal_zone_master_version,
      sku_override, package_selection_rule, package_profile, shopify_location,
      pickup_location CASCADE;
    DROP FUNCTION IF EXISTS create_shipment_partition(int, int);
    DROP FUNCTION IF EXISTS enforce_single_collectible();
    DROP FUNCTION IF EXISTS guard_shipment_row();
    DROP FUNCTION IF EXISTS guard_default_package_profile_delete();
    DROP TYPE IF EXISTS order_source, booking_intent_outcome, expected_cost_basis,
      movement_state, custody_state, manual_assignment_reason, booking_state,
      allocation_state, cod_assignment_state, payment_mode, order_state;
  `);
};
