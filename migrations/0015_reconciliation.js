/**
 * 0015 — weeks 14–15 schema: reconciliation (§2.7) with the §4.8/§3.28
 * control-total machinery, the COD expected ledger, and recon settings
 * (§7.5 S-27–S-30).
 *
 * DB-level guards:
 * - §10.4: a recon row's IMPORTED values and mismatch flags never change;
 *   only workflow_state and remark (plus the computed expectation fields at
 *   match time) may update — trigger.
 * - A1-06: recon_freight_adjustment and recon_cod_allocation are append-only
 *   (make_append_only: revoke + trigger).
 * - §3.28: ACCEPTED_WITH_REMARK requires a non-empty residual_remark — CHECK.
 * - INV-14: content_hash unique per shop on both batch tables.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §3.13 CHARGE_TYPE
    CREATE TYPE charge_type AS ENUM (
      'FORWARD', 'RTO', 'REATTEMPT', 'COD_FEE', 'ADJUSTMENT', 'OTHER'
    );

    -- §3.14 RECON_WORKFLOW_STATE
    CREATE TYPE recon_workflow_state AS ENUM (
      'OPEN', 'ACCEPTED', 'DISPUTE_PREPARED', 'SUBMITTED', 'RESOLVED', 'IGNORED'
    );

    -- §3.15 COD_EXPECTED_STATE
    CREATE TYPE cod_expected_state AS ENUM (
      'AWAITING', 'TALLIED', 'SHORT', 'EXCESS', 'PENDING_OVERDUE', 'RTO_UNCOLLECTED'
    );

    -- §3.18 RECON_BATCH_STATE
    CREATE TYPE recon_batch_state AS ENUM (
      'UPLOADED', 'PARSED', 'MATCHED', 'RESOLVED', 'FAILED'
    );

    -- §3.28 CONTROL_TOTAL_STATE
    CREATE TYPE control_total_state AS ENUM (
      'WITHIN_THRESHOLD', 'MISMATCH', 'ACCEPTED_WITH_REMARK'
    );

    -- §3.31 import_column_map.kind
    CREATE TYPE import_map_kind AS ENUM ('FREIGHT', 'COD');

    -- §7.5 recon settings (Shop defaults; per-account overrides live on
    -- courier_account, null = inherit, A1-06).
    CREATE TABLE recon_settings (
      shop_id uuid PRIMARY KEY REFERENCES shop (shop_id),
      freight_enabled boolean NOT NULL DEFAULT true,          -- S-27
      freight_tolerance numeric(19,4) NOT NULL DEFAULT 1.00 CHECK (freight_tolerance >= 0),
      weight_tolerance_kg numeric(10,3) NOT NULL DEFAULT 0.010 CHECK (weight_tolerance_kg >= 0),  -- S-28
      cod_enabled boolean NOT NULL DEFAULT true,              -- S-29
      cod_tolerance numeric(19,4) NOT NULL DEFAULT 1.00 CHECK (cod_tolerance >= 0),
      cod_due_days integer NOT NULL DEFAULT 7 CHECK (cod_due_days > 0),  -- S-30
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- §2.7 import_column_map [global]: per-Courier admin-maintained
    -- column-mapping templates (A2-05).
    CREATE TABLE import_column_map (                             -- [global]
      column_map_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      courier_id uuid NOT NULL REFERENCES courier (courier_id),
      kind import_map_kind NOT NULL,
      name text NOT NULL,
      mappings_json jsonb NOT NULL,
      charge_type_column text,
      charge_type_value_map jsonb,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (courier_id, kind, name)
    );

    CREATE TABLE recon_freight_batch (
      batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      courier_account_id uuid NOT NULL REFERENCES courier_account (courier_account_id),
      batch_reference text NOT NULL,            -- §13.5: FREIGHT-{yyyymmdd}-{seq}
      filename text NOT NULL,
      content_hash text NOT NULL,
      column_map_id uuid REFERENCES import_column_map (column_map_id),
      currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      tax_treatment text NOT NULL CHECK (tax_treatment IN ('TAX_INCLUSIVE', 'TAX_EXCLUSIVE')),
      invoice_reference text,
      invoice_date date,                        -- never future-dated (§5.2)
      declared_invoice_total numeric(19,4) CHECK (declared_invoice_total >= 0),
      uploaded_by uuid,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      state recon_batch_state NOT NULL DEFAULT 'UPLOADED',
      residual numeric(19,4),                   -- F-14
      control_total_state control_total_state NOT NULL DEFAULT 'WITHIN_THRESHOLD',
      residual_remark text,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, content_hash),           -- INV-14
      -- §3.28: a residual acceptance requires the remark.
      CHECK (control_total_state <> 'ACCEPTED_WITH_REMARK'
             OR NULLIF(btrim(residual_remark), '') IS NOT NULL)
    );

    CREATE TABLE recon_freight_row (
      row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL REFERENCES recon_freight_batch (batch_id),
      awb_normalized text NOT NULL,             -- F-19 at parse
      charge_type charge_type NOT NULL DEFAULT 'FORWARD',
      invoiced_amount numeric(19,4),
      invoiced_weight_kg numeric(10,3),
      -- §9.17.2 reference fields, retained from the reference model
      shipper_company text,
      invoice_reference text,
      invoice_date date,
      shipment_date date,
      origin_station text,
      destination_station text,
      filename text,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      remark text,
      -- Independent flags (§4.8) — never overwritten by workflow state
      flag_awb_not_found boolean NOT NULL DEFAULT false,
      flag_weight_mismatch boolean NOT NULL DEFAULT false,
      flag_amount_mismatch boolean NOT NULL DEFAULT false,
      flag_review boolean NOT NULL DEFAULT false,
      workflow_state recon_workflow_state NOT NULL DEFAULT 'OPEN',
      expected_amount numeric(19,4),            -- null exactly when basis is NONE (§4.5)
      audited_amount numeric(19,4),             -- F-23
      shipment_id uuid,
      adjusts_row_id uuid REFERENCES recon_freight_row (row_id),
      dispute_evidence_object_key text,         -- ADD-42: courier reweigh evidence
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX recon_freight_row_awb ON recon_freight_row (awb_normalized);
    CREATE INDEX recon_freight_row_workflow ON recon_freight_row (batch_id, workflow_state);

    -- §10.4: imported values and flags are immutable; workflow state and
    -- remark (and the computed expectation at match time) may update.
    CREATE OR REPLACE FUNCTION guard_recon_freight_row() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
         OR NEW.awb_normalized IS DISTINCT FROM OLD.awb_normalized
         OR NEW.charge_type IS DISTINCT FROM OLD.charge_type
         OR NEW.invoiced_amount IS DISTINCT FROM OLD.invoiced_amount
         OR NEW.invoiced_weight_kg IS DISTINCT FROM OLD.invoiced_weight_kg
         OR NEW.flag_awb_not_found IS DISTINCT FROM OLD.flag_awb_not_found
         OR NEW.flag_weight_mismatch IS DISTINCT FROM OLD.flag_weight_mismatch
         OR NEW.flag_amount_mismatch IS DISTINCT FROM OLD.flag_amount_mismatch
         OR NEW.flag_review IS DISTINCT FROM OLD.flag_review THEN
        RAISE EXCEPTION '§10.4: recon row imported values and flags are immutable';
      END IF;
      RETURN NEW;
    END;
    $fn$;
    CREATE TRIGGER recon_freight_row_guard BEFORE UPDATE ON recon_freight_row
      FOR EACH ROW EXECUTE FUNCTION guard_recon_freight_row();

    -- A1-06: an ADJUSTMENT is an append-only linked record, never an
    -- overwrite of the row it adjusts.
    CREATE TABLE recon_freight_adjustment (
      adjustment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      row_id uuid NOT NULL REFERENCES recon_freight_row (row_id),
      adjusting_batch_id uuid NOT NULL REFERENCES recon_freight_batch (batch_id),
      amount numeric(19,4) NOT NULL,            -- signed (§4.1 adjustment rows)
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    SELECT make_append_only('recon_freight_adjustment');

    -- §9.17.3: created when a Collectible-bearing NON-TEST Shipment reaches
    -- DELIVERED (INV-19). Remittances allocate against it.
    CREATE TABLE recon_cod_expected (
      expected_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shipment_id uuid NOT NULL UNIQUE,         -- one per Shipment
      expected_amount numeric(19,4) NOT NULL CHECK (expected_amount >= 0),
      delivered_at timestamptz NOT NULL,
      due_at date NOT NULL,                     -- F-21 (delivered_at + effective cod_due_days, shop-local)
      state cod_expected_state NOT NULL DEFAULT 'AWAITING',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE recon_cod_batch (
      cod_batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      courier_account_id uuid NOT NULL REFERENCES courier_account (courier_account_id),
      batch_reference text NOT NULL,            -- §13.5: COD-{yyyymmdd}-{seq}
      filename text NOT NULL,
      content_hash text NOT NULL,
      column_map_id uuid REFERENCES import_column_map (column_map_id),
      remittance_reference text,
      remittance_date date,                     -- never future-dated (§5.2)
      declared_total numeric(19,4) CHECK (declared_total >= 0),
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      state recon_batch_state NOT NULL DEFAULT 'UPLOADED',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, content_hash)            -- INV-14
    );

    CREATE TABLE recon_cod_allocation (
      allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cod_batch_id uuid NOT NULL REFERENCES recon_cod_batch (cod_batch_id),
      expected_id uuid NOT NULL REFERENCES recon_cod_expected (expected_id),
      amount numeric(19,4) NOT NULL CHECK (amount >= 0),
      idempotency_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    SELECT make_append_only('recon_cod_allocation');

    CREATE TRIGGER t BEFORE UPDATE ON recon_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON import_column_map FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON recon_freight_batch FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON recon_freight_row FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON recon_cod_expected FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON recon_cod_batch FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      recon_settings, import_column_map, recon_freight_batch, recon_freight_row,
      recon_cod_expected, recon_cod_batch
      TO jsyxi_app;
    GRANT SELECT, INSERT ON recon_freight_adjustment, recon_cod_allocation TO jsyxi_app;
    GRANT USAGE ON TYPE
      charge_type, recon_workflow_state, cod_expected_state,
      recon_batch_state, control_total_state, import_map_kind
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS recon_cod_allocation, recon_cod_batch,
      recon_cod_expected, recon_freight_adjustment, recon_freight_row,
      recon_freight_batch, import_column_map, recon_settings;
    DROP FUNCTION IF EXISTS guard_recon_freight_row();
    DROP TYPE IF EXISTS import_map_kind, control_total_state, recon_batch_state,
      cod_expected_state, recon_workflow_state, charge_type;
  `);
};
