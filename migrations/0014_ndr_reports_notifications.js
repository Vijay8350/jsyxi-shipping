/**
 * 0014 — weeks 13–14 schema: NDR suite (§2.5, §3.10), dashboard rollups
 * (§2.8), reports (§2.8), and the notification/channel layer (§9.21 +
 * ADD-25/26/27/28).
 *
 * ADD-28's COD_UNCONFIRMED hold joins §3.30's value list.
 * ADD-27's buyer self-serve stores a durable, audited response record; the
 * NDR action is created FROM the record, never from message delivery (the
 * stated INV-21 exception).
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §3.10 NDR value lists
    CREATE TYPE ndr_reason AS ENUM (
      'CUSTOMER_REFUSED', 'UNCONTACTABLE', 'ADDRESS_ISSUE', 'COD_NOT_READY', 'OTHER'
    );
    CREATE TYPE ndr_action_type AS ENUM (
      'REATTEMPT', 'UPDATE_ADDRESS_AND_REATTEMPT', 'INITIATE_RTO'
    );
    CREATE TYPE ndr_case_state AS ENUM (
      'OPEN', 'ACTION_SUBMITTED', 'REATTEMPT_SCHEDULED', 'RTO_REQUESTED', 'CLOSED'
    );

    -- ADD-28: the COD-confirmation hold joins §3.30.
    ALTER TYPE manual_assignment_reason ADD VALUE IF NOT EXISTS 'COD_UNCONFIRMED';

    CREATE TABLE ndr_case (
      ndr_case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shipment_id uuid NOT NULL,
      attempt_count integer NOT NULL DEFAULT 1,
      reason_code ndr_reason NOT NULL DEFAULT 'OTHER',   -- RV-14: unmappable is never discarded
      first_ndr_at timestamptz NOT NULL,
      last_ndr_at timestamptz NOT NULL,
      state ndr_case_state NOT NULL DEFAULT 'OPEN',
      auto_rto_warn_at timestamptz,                      -- S-44 (48h default)
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ndr_case_shop_state ON ndr_case (shop_id, state);
    CREATE INDEX ndr_case_shipment ON ndr_case (shipment_id) WHERE state <> 'CLOSED';

    CREATE TABLE ndr_action (
      ndr_action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ndr_case_id uuid NOT NULL REFERENCES ndr_case (ndr_case_id),
      action ndr_action_type NOT NULL,
      actor_member_id uuid,                 -- null for system/buyer-driven actions
      payload jsonb NOT NULL DEFAULT '{}',
      submitted_at timestamptz NOT NULL DEFAULT now(),
      provider_ack text,
      result text,                          -- provider outcome summary
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ndr_action_case ON ndr_action (ndr_case_id, submitted_at);

    -- §2.5 ndr_settings (per Shop — A4-02 moved it off pickup locations).
    CREATE TABLE ndr_settings (
      shop_id uuid PRIMARY KEY REFERENCES shop (shop_id),
      recipients jsonb NOT NULL DEFAULT '[]',           -- S-41
      channel text NOT NULL DEFAULT 'email',            -- S-42 digest channel
      digest_frequency text NOT NULL DEFAULT 'daily'    -- S-42
        CHECK (digest_frequency IN ('hourly', 'daily', 'weekly')),
      auto_reattempt_once boolean NOT NULL DEFAULT false,  -- S-43
      escalation_templates jsonb NOT NULL DEFAULT '[]',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- ADD-27: the stored, audited buyer response the NDR action is created
    -- FROM (the INV-21 exception, made explicit in code).
    CREATE TABLE ndr_buyer_response (
      response_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      ndr_case_id uuid NOT NULL REFERENCES ndr_case (ndr_case_id),
      response_type text NOT NULL CHECK (response_type IN (
        'CONFIRM_ADDRESS', 'CORRECT_ADDRESS', 'CHOOSE_REATTEMPT_DATE', 'COD_TO_PREPAID'
      )),
      payload jsonb NOT NULL DEFAULT '{}',
      ndr_action_id uuid REFERENCES ndr_action (ndr_action_id),  -- the action it drove
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- ADD-27 tokenized buyer links (per NDR case, hashed, single-purpose).
    CREATE TABLE ndr_response_token (
      token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      ndr_case_id uuid NOT NULL REFERENCES ndr_case (ndr_case_id),
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );

    -- §2.8 rollup_hourly_stats: dashboard and report figures come from
    -- maintained hourly rollups, never per-row subqueries at render (§5.7).
    CREATE TABLE rollup_hourly_stats (
      rollup_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      hour_start_utc timestamptz NOT NULL,
      dimension_json jsonb NOT NULL,
      metrics_json jsonb NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, hour_start_utc, dimension_json)
    );

    -- §2.8 report_job / report_schedule (§11, §3.27).
    CREATE TABLE report_job (
      report_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      report_code text NOT NULL,              -- §11 catalogue codes
      filters jsonb NOT NULL DEFAULT '{}',
      requested_by uuid,
      state job_state NOT NULL DEFAULT 'QUEUED',
      as_of_at timestamptz NOT NULL DEFAULT now(),   -- exports are immutable as-of (§5.2)
      result_document_id uuid REFERENCES document (document_id),
      row_count integer,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE report_schedule (
      schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      report_code text NOT NULL,
      filters jsonb NOT NULL DEFAULT '{}',
      cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
      recipients jsonb NOT NULL DEFAULT '[]',
      next_run_at timestamptz NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    --------------------------------------------------------------------
    -- §9.21 + ADD-25/26: the notification/channel layer.
    --------------------------------------------------------------------

    CREATE TYPE message_channel AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');
    CREATE TYPE message_delivery_state AS ENUM (
      'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'
    );

    -- ADD-25: per-Shop provider credentials per channel (envelope-encrypted).
    CREATE TABLE shop_message_channel (
      channel_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      channel message_channel NOT NULL,
      provider text NOT NULL,                 -- e.g. the transactional email provider, a DLT SMS route, a WhatsApp BSP
      credentials_encrypted bytea,
      enabled boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, channel)
    );

    -- ADD-26 + India compliance: every template stores its external approval
    -- ID (DLT template ID / Meta template name); NO message sends on an
    -- unapproved template (channel SMS/WHATSAPP require approval; EMAIL is
    -- in-house and approves implicitly).
    CREATE TABLE message_template (
      template_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid REFERENCES shop (shop_id),   -- null = platform default
      event text NOT NULL,                      -- e.g. shipment.shipped, ndr.attempted
      channel message_channel NOT NULL,
      body text NOT NULL,
      external_approval_id text,                -- DLT / BSP approval reference
      is_active boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- ADD-25 delivery log: one row per message per channel attempt.
    CREATE TABLE message_log (
      message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      channel message_channel NOT NULL,
      event text NOT NULL,
      template_id uuid REFERENCES message_template (template_id),
      recipient_ref text,                       -- salted hash, never raw (§5.7 control 4)
      shipment_id uuid,
      ndr_case_id uuid,
      state message_delivery_state NOT NULL DEFAULT 'QUEUED',
      provider_ref text,
      failure_reason text,
      queued_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz,
      delivered_at timestamptz,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX message_log_shop_event ON message_log (shop_id, event, queued_at);

    -- §9.21 per-event toggles (S-45) + recipient/channel selection (ADD-25).
    CREATE TABLE notification_settings (
      shop_id uuid PRIMARY KEY REFERENCES shop (shop_id),
      event_toggles jsonb NOT NULL DEFAULT '{}',  -- S-45: every operational alert on
      channel_selection jsonb NOT NULL DEFAULT '{}', -- ADD-25 per-event channel choice
      suppressed_addresses jsonb NOT NULL DEFAULT '[]', -- hard-bounce suppression (§9.21)
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- ADD-28: COD order confirmation state per order.
    CREATE TABLE cod_confirmation (
      confirmation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      order_id uuid NOT NULL REFERENCES "order" (order_id),
      token_hash text NOT NULL UNIQUE,
      state text NOT NULL DEFAULT 'PENDING'
        CHECK (state IN ('PENDING', 'CONFIRMED', 'EXPIRED_BOOKED', 'EXPIRED_HELD')),
      responded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, order_id)
    );

    CREATE TRIGGER t BEFORE UPDATE ON ndr_case FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON ndr_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON report_job FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON report_schedule FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON shop_message_channel FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON message_template FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON notification_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ndr_case, ndr_settings, rollup_hourly_stats, report_job, report_schedule,
      shop_message_channel, message_template, message_log, notification_settings,
      cod_confirmation
      TO jsyxi_app;
    GRANT SELECT, INSERT, UPDATE ON ndr_action, ndr_buyer_response TO jsyxi_app;
    GRANT SELECT, INSERT ON ndr_response_token TO jsyxi_app;
    GRANT USAGE ON TYPE
      ndr_reason, ndr_action_type, ndr_case_state,
      message_channel, message_delivery_state
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS cod_confirmation, notification_settings, message_log,
      message_template, shop_message_channel, report_schedule, report_job,
      rollup_hourly_stats, ndr_response_token, ndr_buyer_response, ndr_settings,
      ndr_action, ndr_case;
    DROP TYPE IF EXISTS message_delivery_state, message_channel,
      ndr_case_state, ndr_action_type, ndr_reason;
  `);
};
