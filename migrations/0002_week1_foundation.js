/**
 * 0002 — weeks 1–2 schema: tenancy, identity (incl. Addendum A OVR-1 native
 * auth), billing skeleton, and platform tables (plan §4.1).
 *
 * Every Shop-scoped table carries shop_id and every unique key includes it
 * (INV-1). Every mutable entity carries an integer `version` for the INV-22
 * optimistic concurrency check. Money is NUMERIC(19,4) with a currency code
 * on every financial row (§4.1, INV-2). Append-only tables get the
 * make_append_only() guard from 0001.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Generic updated_at maintenance for mutable tables.
    CREATE OR REPLACE FUNCTION touch_updated_at()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $fn$;

    --------------------------------------------------------------------
    -- §2.1 Tenancy, identity & billing
    --------------------------------------------------------------------

    CREATE TABLE shop (                                        -- [global]
      shop_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shopify_shop_gid text NOT NULL UNIQUE,
      myshopify_domain text NOT NULL,
      shop_currency text NOT NULL DEFAULT 'INR' CHECK (shop_currency = 'INR'),  -- INV-2
      iana_timezone text NOT NULL DEFAULT 'Asia/Kolkata',
      installed_at timestamptz NOT NULL DEFAULT now(),
      uninstalled_at timestamptz,
      account_state account_state NOT NULL DEFAULT 'TRIALING',
      -- Envelope-encrypted Shopify access token (§5.7 control 1). Destroyed on
      -- uninstall and by no other account state (§3.11, §5.5).
      shopify_access_token_encrypted bytea,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE shop_member (
      member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shopify_staff_user_id text,                       -- SHOPIFY_STAFF only
      email text,                                       -- NATIVE only (OVR-1)
      auth_source auth_source NOT NULL,
      role member_role NOT NULL,
      granted_by uuid,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      last_active_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (
        (auth_source = 'SHOPIFY_STAFF' AND shopify_staff_user_id IS NOT NULL)
        OR (auth_source = 'NATIVE' AND email IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX shop_member_staff_key
      ON shop_member (shop_id, shopify_staff_user_id)
      WHERE shopify_staff_user_id IS NOT NULL;
    CREATE UNIQUE INDEX shop_member_email_key
      ON shop_member (shop_id, lower(email))
      WHERE email IS NOT NULL;
    -- §9.1.2: exactly one Owner at a time.
    CREATE UNIQUE INDEX shop_member_one_owner
      ON shop_member (shop_id)
      WHERE role = 'OWNER' AND revoked_at IS NULL;

    -- OVR-1: credentials for NATIVE members only (enforced in app + tested;
    -- a cross-table CHECK is not expressible in SQL).
    CREATE TABLE member_credential (
      member_id uuid PRIMARY KEY REFERENCES shop_member (member_id),
      password_hash text,                               -- argon2id
      totp_secret_encrypted bytea,                      -- envelope-encrypted
      totp_confirmed boolean NOT NULL DEFAULT false,
      failed_attempts integer NOT NULL DEFAULT 0,
      locked_until timestamptz,
      password_reset_token_hash text,
      password_reset_expires_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- OVR-1: Owner-issued email invite for native members.
    CREATE TABLE member_invite (
      invite_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      email text NOT NULL,
      role member_role NOT NULL CHECK (role <> 'OWNER'),  -- OVR-1: never Owner
      token_hash text NOT NULL UNIQUE,
      invited_by uuid NOT NULL,
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- OVR-1: single-use magic-link login tokens.
    CREATE TABLE magic_link_token (
      token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      member_id uuid NOT NULL REFERENCES shop_member (member_id),
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Sessions bind to (shop_id, member_id) for both auth sources (INV-1
    -- unchanged, OVR-1). 12h inactivity TTL (RW-04); invalidated on uninstall,
    -- Shopify revocation, role revocation, Owner transfer, native revoke.
    CREATE TABLE member_session (
      session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      member_id uuid NOT NULL REFERENCES shop_member (member_id),
      token_hash text NOT NULL UNIQUE,
      auth_source auth_source NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_active_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      invalidated_at timestamptz,
      invalidate_reason text,
      ip_hash text
    );
    CREATE INDEX member_session_member ON member_session (member_id)
      WHERE invalidated_at IS NULL;

    CREATE TABLE access_request (
      request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shopify_staff_user_id text NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      resolved_by uuid,
      resolution access_request_resolution NOT NULL DEFAULT 'PENDING',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX access_request_one_pending
      ON access_request (shop_id, shopify_staff_user_id)
      WHERE resolution = 'PENDING';

    CREATE TABLE store_settings (
      shop_id uuid PRIMARY KEY REFERENCES shop (shop_id),
      language text NOT NULL DEFAULT 'en',                    -- S-1
      timezone text NOT NULL DEFAULT 'Asia/Kolkata',          -- S-2
      currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),  -- S-3, INV-2
      decimal_separator text NOT NULL DEFAULT '.',            -- S-4
      decimal_digits integer NOT NULL DEFAULT 2,              -- S-4
      weight_unit text NOT NULL DEFAULT 'kg',                 -- S-5
      measurement_unit text NOT NULL DEFAULT 'cm',            -- S-6
      default_parcel_weight_kg numeric(10,3) NOT NULL DEFAULT 0.500
        CHECK (default_parcel_weight_kg > 0),                 -- S-7
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE plan (                                        -- [global]
      plan_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      awb_allowance_per_cycle integer NOT NULL CHECK (awb_allowance_per_cycle >= 0),
      price numeric(19,4) NOT NULL CHECK (price >= 0),
      currency text NOT NULL DEFAULT 'INR',
      overage_unit_price numeric(19,4) NOT NULL CHECK (overage_unit_price >= 0),
      is_trial boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE subscription (
      subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      plan_id uuid NOT NULL REFERENCES plan (plan_id),
      shopify_subscription_gid text,
      cycle_start_at timestamptz,
      cycle_end_at timestamptz,
      state account_state NOT NULL DEFAULT 'TRIALING',
      capped_amount numeric(19,4) CHECK (capped_amount >= 0),
      currency text NOT NULL DEFAULT 'INR',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- INV-12: append-only; exactly one DEBIT per durably-confirmed non-test
    -- AWB; at most one REVERSAL, only after courier-confirmed cancellation
    -- before any pickup event. Separate from Shopify charge records (A1-04).
    -- shipment_id / booking_intent_id FKs are added when those tables land
    -- (weeks 3–4 migration).
    CREATE TABLE awb_entitlement_ledger (
      entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      subscription_id uuid NOT NULL REFERENCES subscription (subscription_id),
      cycle_start_at timestamptz NOT NULL,
      shipment_id uuid,
      direction ledger_direction NOT NULL,
      booking_intent_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX awb_ledger_one_debit
      ON awb_entitlement_ledger (shipment_id) WHERE direction = 'DEBIT';
    CREATE UNIQUE INDEX awb_ledger_one_reversal
      ON awb_entitlement_ledger (shipment_id) WHERE direction = 'REVERSAL';
    SELECT make_append_only('awb_entitlement_ledger');

    CREATE TABLE usage_record (
      usage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      subscription_id uuid NOT NULL REFERENCES subscription (subscription_id),
      idempotency_key text NOT NULL UNIQUE,
      shopify_usage_record_gid text,
      amount numeric(19,4) NOT NULL CHECK (amount >= 0),
      currency text NOT NULL DEFAULT 'INR',
      state usage_record_state NOT NULL DEFAULT 'PENDING',
      submitted_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE overage_credit (
      credit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      subscription_id uuid NOT NULL REFERENCES subscription (subscription_id),
      amount numeric(19,4) NOT NULL,     -- signed: a credit row (§4.1, A1-04)
      currency text NOT NULL DEFAULT 'INR',
      source_usage_id uuid NOT NULL REFERENCES usage_record (usage_id),
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    --------------------------------------------------------------------
    -- ADD-20: merchant API keys (key model designed now, endpoints later)
    --------------------------------------------------------------------

    CREATE TABLE api_key (
      key_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      name text NOT NULL,
      key_hash text NOT NULL UNIQUE,      -- plaintext key is never stored
      scopes text[] NOT NULL CHECK (
        scopes <@ ARRAY['read-orders', 'book', 'track', 'reports']::text[]
        AND array_length(scopes, 1) >= 1
      ),
      rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute > 0),
      last_used_at timestamptz,
      rotated_from_key_id uuid REFERENCES api_key (key_id),
      revoked_at timestamptz,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    --------------------------------------------------------------------
    -- §2.8 Platform
    --------------------------------------------------------------------

    -- §12: append-only, 7 financial years. who did what to which object with
    -- before/after — never payload dumps, never secrets (INV-18). OVR-1 adds
    -- every native login to the always-audited list.
    CREATE TABLE audit_log (
      audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid,                       -- null for platform-global events
      actor_kind audit_actor_kind NOT NULL,
      actor_id uuid,
      action text NOT NULL,
      object_type text,
      object_id text,
      before jsonb,
      after jsonb,
      reason text,
      ip_hash text,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_log_shop_time ON audit_log (shop_id, occurred_at);
    SELECT make_append_only('audit_log');

    CREATE TABLE dlq_item (
      dlq_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      queue text NOT NULL,
      payload jsonb NOT NULL,
      error text,
      attempts integer NOT NULL DEFAULT 0,
      failed_at timestamptz NOT NULL DEFAULT now(),
      replayed_at timestamptz,
      replayed_by uuid
    );

    CREATE TABLE feature_flag (                                -- [global]
      flag_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL,
      scope feature_flag_scope NOT NULL,
      shop_id uuid,
      enabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX feature_flag_key_scope_shop
      ON feature_flag (key, COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid));

    -- §2.5, §8.1: durable RECEIVED row is written before the 2xx; dedupe on
    -- (shop_id, topic, external_id). Created with the foundation so the
    -- stateless ingest tier exists before order sync lands in week 3.
    CREATE TABLE webhook_inbox (
      inbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      source webhook_source NOT NULL,
      topic text NOT NULL,
      external_id text NOT NULL,
      payload jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      state webhook_inbox_state NOT NULL DEFAULT 'RECEIVED',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, topic, external_id)
    );

    --------------------------------------------------------------------
    -- updated_at triggers on every mutable table.
    --------------------------------------------------------------------

    CREATE TRIGGER t BEFORE UPDATE ON shop FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON shop_member FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON member_credential FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON access_request FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON store_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON plan FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON usage_record FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON api_key FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON feature_flag FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON webhook_inbox FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    --------------------------------------------------------------------
    -- Least-privilege grants for the application role. Append-only tables
    -- already had UPDATE/DELETE revoked by make_append_only().
    --------------------------------------------------------------------

    GRANT USAGE ON SCHEMA public TO jsyxi_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      shop, shop_member, member_credential, member_invite, magic_link_token,
      member_session, access_request, store_settings, plan, subscription,
      usage_record, overage_credit, api_key,
      dlq_item, feature_flag, webhook_inbox
      TO jsyxi_app;
    -- Append-only tables (INV-12, §12): INSERT and SELECT only — UPDATE and
    -- DELETE stay revoked (make_append_only above), the trigger is the
    -- second layer.
    GRANT SELECT, INSERT ON awb_entitlement_ledger, audit_log TO jsyxi_app;
    GRANT USAGE ON TYPE
      account_state, member_role, auth_source, access_request_resolution,
      ledger_direction, usage_record_state, audit_actor_kind,
      webhook_inbox_state, webhook_source, feature_flag_scope
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS webhook_inbox, feature_flag, dlq_item, audit_log,
      api_key, overage_credit, usage_record, awb_entitlement_ledger,
      subscription, plan, store_settings, access_request, member_session,
      magic_link_token, member_invite, member_credential, shop_member, shop
      CASCADE;
    DROP FUNCTION IF EXISTS touch_updated_at();
  `);
};
