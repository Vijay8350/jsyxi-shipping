/**
 * 0006 — weeks 4–6 schema: courier master & merchant courier setup (§2.2)
 * and the pricing reference: zone maps and rate cards (§2.3 remainder).
 *
 * DB-level guards:
 * - INV-11: a sealed rate_card_version / commercial_zone_map / service_version
 *   (referenced by a booking snapshot) cannot be edited or deleted — trigger;
 *   the only permitted UPDATE is sealing (is_sealed false → true). Child rows
 *   (slabs, components, zone rules) are frozen with their parent.
 * - RW-20: two independent envelope ciphertexts on courier_account (test and
 *   live) — switching mode never overwrites the other set.
 * - §3.31 / §3.7 / §3.21 / §3.6 value lists as PG enums (RV-07).
 * - ADD-41: rate_card_component.basis gains PERCENT_OF_DECLARED_VALUE so an
 *   insured shipment's expected cost is computable and reconcilable.
 * - ADD-18: the per-account inbound webhook URL token and signing secret are
 *   separate columns so each can be regenerated independently (audited).
 */

exports.up = (pgm) => {
  pgm.sql(`
    --------------------------------------------------------------------
    -- Enum types (spec.md §3 value lists, verbatim; RV-07).
    --------------------------------------------------------------------

    -- §3.31 courier.kind / courier.auth_pattern / courier_account.mode /
    -- service.label_mode
    CREATE TYPE courier_kind AS ENUM ('DIRECT', 'AGGREGATOR');
    CREATE TYPE courier_auth_pattern AS ENUM ('KEY_PASTE', 'OAUTH');
    CREATE TYPE courier_account_mode AS ENUM ('TEST', 'LIVE');
    CREATE TYPE service_label_mode AS ENUM ('COURIER_PDF_REQUIRED', 'CUSTOM_ALLOWED');

    -- §3.21 COURIER_ACCOUNT_HEALTH
    CREATE TYPE courier_account_health AS ENUM (
      'UNVERIFIED', 'HEALTHY', 'DEGRADED', 'DISCONNECTED', 'DISABLED'
    );

    -- §3.7 COST_SOURCE
    CREATE TYPE cost_source AS ENUM ('RATE_CARD', 'LIVE_QUOTE', 'NONE');

    -- §3.6 CARRIER_EVENT_STATUS — the only mapping target (A2-06)
    CREATE TYPE carrier_event_status AS ENUM (
      'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
      'DELIVERED', 'UNDELIVERED_ATTEMPT', 'RTO_INITIATED', 'RTO_IN_TRANSIT',
      'RTO_OUT_FOR_DELIVERY', 'RTO_DELIVERED', 'LOST_OR_DAMAGED',
      'CANCELLED_BY_COURIER'
    );

    -- Zone A–E (§1, §4.3) — a pricing concept, distinct from a Saved zone.
    CREATE TYPE zone_code AS ENUM ('A', 'B', 'C', 'D', 'E');

    -- §3.31 rate_card_version.rto_basis
    CREATE TYPE rto_basis AS ENUM ('SAME_AS_FORWARD', 'PERCENT_OF_FORWARD');

    -- §3.31 rate_card_component.basis + PERCENT_OF_DECLARED_VALUE (ADD-41)
    CREATE TYPE rate_component_basis AS ENUM (
      'FLAT', 'PERCENT_OF_BASE_FREIGHT', 'PERCENT_OF_PRE_TAX_SUBTOTAL',
      'PER_KG_BILLABLE', 'PERCENT_OF_DECLARED_VALUE'
    );

    --------------------------------------------------------------------
    -- §2.2 Courier master & merchant courier setup
    --------------------------------------------------------------------

    CREATE TABLE courier (                                       -- [global]
      courier_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      kind courier_kind NOT NULL,
      auth_pattern courier_auth_pattern NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Drives the merchant credential form (A1-12); is_secret fields are
    -- write-only with masked display (§5.7 control 3, INV-18).
    CREATE TABLE courier_credential_field (                      -- [global]
      field_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      courier_id uuid NOT NULL REFERENCES courier (courier_id),
      key text NOT NULL,
      label text NOT NULL,
      type text NOT NULL DEFAULT 'text',
      is_secret boolean NOT NULL DEFAULT false,
      is_required boolean NOT NULL DEFAULT true,
      validation_regex text,
      display_order integer NOT NULL DEFAULT 0,
      UNIQUE (courier_id, key)
    );

    -- §8.2: a capability a courier lacks is declared supported = false with a
    -- manual fallback note — a silent no-op is never permitted (A1-03).
    CREATE TABLE courier_capability (                            -- [global]
      capability_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      courier_id uuid NOT NULL REFERENCES courier (courier_id),
      capability text NOT NULL,          -- §8.2 method names
      supported boolean NOT NULL,
      manual_fallback_note text,
      UNIQUE (courier_id, capability)
    );

    -- Services, not Couriers, are what rules, rate cards, bookings, labels
    -- and reports operate on (§1, §9.3.2).
    CREATE TABLE service (                                       -- [global]
      service_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      courier_id uuid NOT NULL REFERENCES courier (courier_id),
      code text NOT NULL,
      name text NOT NULL,
      label_mode service_label_mode NOT NULL,
      cost_source cost_source NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (courier_id, code)
    );

    -- Versioned divisor / minimum / increment (§4.2–§4.4); sealed once
    -- referenced by a booking snapshot (INV-11).
    CREATE TABLE service_version (                               -- [global]
      service_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_id uuid NOT NULL REFERENCES service (service_id),
      effective_from date NOT NULL,
      volumetric_divisor numeric(12,4) CHECK (volumetric_divisor > 0),
      min_billable_kg numeric(10,3) NOT NULL DEFAULT 0.5 CHECK (min_billable_kg >= 0),
      billable_increment_kg numeric(10,3) NOT NULL DEFAULT 0.5 CHECK (billable_increment_kg > 0),
      supports_cod boolean NOT NULL DEFAULT true,
      supports_reverse boolean NOT NULL DEFAULT false,
      is_sealed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE courier_status_map (                            -- [global]
      map_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      courier_id uuid NOT NULL REFERENCES courier (courier_id),
      raw_status text NOT NULL,            -- normalized case-folded before write
      carrier_event_status carrier_event_status NOT NULL,
      UNIQUE (courier_id, raw_status)
    );

    CREATE TABLE courier_guide (                                 -- [global]
      guide_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      courier_id uuid NOT NULL REFERENCES courier (courier_id),
      video_url text,
      doc_url text,
      pdf_object_key text,
      published_at timestamptz
    );

    CREATE TABLE courier_account (
      courier_account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      courier_id uuid NOT NULL REFERENCES courier (courier_id),
      mode courier_account_mode NOT NULL DEFAULT 'TEST',
      -- RW-20 / §5.7 control 1: two independent envelope ciphertexts.
      credentials_test_encrypted bytea,
      credentials_live_encrypted bytea,
      health_state courier_account_health NOT NULL DEFAULT 'UNVERIFIED',
      last_event_received_at timestamptz,
      disabled_at timestamptz,
      -- Nullable reconciliation overrides; null inherits the Shop default
      -- (§7.5, A1-06).
      freight_tolerance numeric(19,4) CHECK (freight_tolerance >= 0),
      weight_tolerance_kg numeric(10,3) CHECK (weight_tolerance_kg >= 0),
      cod_tolerance numeric(19,4) CHECK (cod_tolerance >= 0),
      cod_due_days integer CHECK (cod_due_days > 0),
      -- §8.5 + ADD-18: the inbound webhook URL token and signing secret are
      -- regenerated as separate audited actions.
      webhook_url_token text NOT NULL UNIQUE,
      webhook_secret_encrypted bytea,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, courier_id)
    );

    CREATE TABLE merchant_service (
      merchant_service_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      courier_account_id uuid NOT NULL REFERENCES courier_account (courier_account_id),
      service_id uuid NOT NULL REFERENCES service (service_id),
      enabled boolean NOT NULL DEFAULT true,
      priority_tiebreak_order integer NOT NULL DEFAULT 0,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (courier_account_id, service_id)
    );

    CREATE TABLE courier_request (                               -- [global]
      request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      courier_name_text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    --------------------------------------------------------------------
    -- §2.3 pricing reference: commercial zone maps & rate cards
    --------------------------------------------------------------------

    CREATE TABLE commercial_zone_map (
      zone_map_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      service_id uuid NOT NULL REFERENCES service (service_id),
      label text NOT NULL,
      effective_from date NOT NULL,
      -- Immutable reference: zone rules resolve pincode attributes from THIS
      -- postal version, never the current master (A1-05, F-4).
      postal_version_id uuid NOT NULL
        REFERENCES postal_zone_master_version (postal_version_id),
      is_sealed boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE commercial_zone_rule (
      zone_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      zone_map_id uuid NOT NULL REFERENCES commercial_zone_map (zone_map_id),
      -- Matchers over postal_pincode attributes (pincode / city / district /
      -- state / region / is_metro / is_special), evaluated in position order,
      -- first match wins (F-4).
      origin_matcher jsonb NOT NULL,
      destination_matcher jsonb NOT NULL,
      zone zone_code NOT NULL,
      position integer NOT NULL
    );
    CREATE INDEX commercial_zone_rule_map
      ON commercial_zone_rule (zone_map_id, position);

    CREATE TABLE rate_card (
      rate_card_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      service_id uuid NOT NULL REFERENCES service (service_id),
      courier_account_id uuid NOT NULL REFERENCES courier_account (courier_account_id),
      name text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE rate_card_version (
      rate_card_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rate_card_id uuid NOT NULL REFERENCES rate_card (rate_card_id),
      effective_from date NOT NULL,
      effective_to date,                    -- non-overlapping per rate card (§9.15)
      zone_map_id uuid NOT NULL REFERENCES commercial_zone_map (zone_map_id),
      fuel_pct numeric(12,6) NOT NULL DEFAULT 0 CHECK (fuel_pct >= 0 AND fuel_pct <= 1),
      cod_flat numeric(19,4) NOT NULL DEFAULT 0 CHECK (cod_flat >= 0),
      cod_pct numeric(12,6) NOT NULL DEFAULT 0 CHECK (cod_pct >= 0 AND cod_pct <= 1),
      rto_basis rto_basis NOT NULL DEFAULT 'SAME_AS_FORWARD',
      rto_pct numeric(12,6) CHECK (rto_pct >= 0),
      gst_pct numeric(12,6) NOT NULL DEFAULT 0.18 CHECK (gst_pct >= 0 AND gst_pct <= 1),  -- A2-10
      component_order text[] NOT NULL DEFAULT '{F-5,F-6,F-7,F-8,F-9,F-10,F-11}',  -- §4.4
      taxable_components text[] NOT NULL DEFAULT '{F-5,F-6,F-7,F-8}',             -- A2-10 default
      is_sealed boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE rate_card_slab (
      slab_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rate_card_version_id uuid NOT NULL
        REFERENCES rate_card_version (rate_card_version_id),
      zone zone_code NOT NULL,
      base_weight_kg numeric(10,3) NOT NULL CHECK (base_weight_kg > 0),
      base_rate numeric(19,4) NOT NULL CHECK (base_rate >= 0),
      additional_step_kg numeric(10,3) NOT NULL CHECK (additional_step_kg > 0),
      additional_rate numeric(19,4) NOT NULL CHECK (additional_rate >= 0),
      UNIQUE (rate_card_version_id, zone)
    );

    -- The storage F-8 computes over (RW-19); seeded empty ⇒ F-8 = ₹0.00.
    CREATE TABLE rate_card_component (
      component_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rate_card_version_id uuid NOT NULL
        REFERENCES rate_card_version (rate_card_version_id),
      code text NOT NULL,
      label text NOT NULL,
      basis rate_component_basis NOT NULL,
      value numeric(19,6) NOT NULL CHECK (value >= 0),
      is_taxable boolean NOT NULL DEFAULT true,
      position integer NOT NULL,
      UNIQUE (rate_card_version_id, position)
    );

    --------------------------------------------------------------------
    -- INV-11 seal guards. A sealed version (referenced by any booking
    -- snapshot) cannot be edited or deleted; the only allowed UPDATE is the
    -- seal itself. Children are frozen with their parent.
    --------------------------------------------------------------------

    CREATE OR REPLACE FUNCTION guard_sealed_version() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.is_sealed THEN
          RAISE EXCEPTION 'INV-11: sealed % cannot be deleted', TG_TABLE_NAME;
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.is_sealed THEN
        RAISE EXCEPTION 'INV-11: sealed % is immutable', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER seal_guard BEFORE UPDATE OR DELETE ON service_version
      FOR EACH ROW EXECUTE FUNCTION guard_sealed_version();
    CREATE TRIGGER seal_guard BEFORE UPDATE OR DELETE ON commercial_zone_map
      FOR EACH ROW EXECUTE FUNCTION guard_sealed_version();
    CREATE TRIGGER seal_guard BEFORE UPDATE OR DELETE ON rate_card_version
      FOR EACH ROW EXECUTE FUNCTION guard_sealed_version();

    -- Child-row freeze: writes to slabs / components / zone rules are
    -- rejected once the parent version is sealed.
    CREATE OR REPLACE FUNCTION guard_sealed_children() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      parent_sealed boolean;
    BEGIN
      IF TG_TABLE_NAME = 'commercial_zone_rule' THEN
        SELECT is_sealed INTO parent_sealed FROM commercial_zone_map
         WHERE zone_map_id = COALESCE(NEW.zone_map_id, OLD.zone_map_id);
      ELSIF TG_TABLE_NAME IN ('rate_card_slab', 'rate_card_component') THEN
        SELECT is_sealed INTO parent_sealed FROM rate_card_version
         WHERE rate_card_version_id = COALESCE(NEW.rate_card_version_id, OLD.rate_card_version_id);
      END IF;
      IF parent_sealed THEN
        RAISE EXCEPTION 'INV-11: % rows are frozen because the parent version is sealed', TG_TABLE_NAME;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER seal_children_guard BEFORE INSERT OR UPDATE OR DELETE
      ON commercial_zone_rule FOR EACH ROW EXECUTE FUNCTION guard_sealed_children();
    CREATE TRIGGER seal_children_guard BEFORE INSERT OR UPDATE OR DELETE
      ON rate_card_slab FOR EACH ROW EXECUTE FUNCTION guard_sealed_children();
    CREATE TRIGGER seal_children_guard BEFORE INSERT OR UPDATE OR DELETE
      ON rate_card_component FOR EACH ROW EXECUTE FUNCTION guard_sealed_children();

    --------------------------------------------------------------------
    -- FKs from shipment now that the referenced tables exist.
    --------------------------------------------------------------------

    ALTER TABLE shipment
      ADD CONSTRAINT shipment_service_fk
        FOREIGN KEY (service_id) REFERENCES service (service_id),
      ADD CONSTRAINT shipment_courier_account_fk
        FOREIGN KEY (courier_account_id) REFERENCES courier_account (courier_account_id);

    --------------------------------------------------------------------
    -- updated_at triggers + least-privilege grants.
    --------------------------------------------------------------------

    CREATE TRIGGER t BEFORE UPDATE ON courier FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON service FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON courier_account FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON merchant_service FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON commercial_zone_map FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON rate_card FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON rate_card_version FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      courier, courier_credential_field, courier_capability, service,
      service_version, courier_status_map, courier_guide, courier_account,
      merchant_service, courier_request, commercial_zone_map,
      commercial_zone_rule, rate_card, rate_card_version, rate_card_slab,
      rate_card_component
      TO jsyxi_app;
    GRANT USAGE ON TYPE
      courier_kind, courier_auth_pattern, courier_account_mode,
      service_label_mode, courier_account_health, cost_source,
      carrier_event_status, zone_code, rto_basis, rate_component_basis
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE shipment
      DROP CONSTRAINT IF EXISTS shipment_service_fk,
      DROP CONSTRAINT IF EXISTS shipment_courier_account_fk;
    DROP TABLE IF EXISTS rate_card_component, rate_card_slab, rate_card_version,
      rate_card, commercial_zone_rule, commercial_zone_map, courier_request,
      merchant_service, courier_account, courier_guide, courier_status_map,
      service_version, service, courier_capability, courier_credential_field,
      courier CASCADE;
    DROP FUNCTION IF EXISTS guard_sealed_children();
    DROP FUNCTION IF EXISTS guard_sealed_version();
    DROP TYPE IF EXISTS rate_component_basis, rto_basis, zone_code,
      carrier_event_status, cost_source, courier_account_health,
      service_label_mode, courier_account_mode, courier_auth_pattern, courier_kind;
  `);
};
