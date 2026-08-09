/**
 * 0010 — weeks 8–9 schema: tracking tables (§2.5, partitioned by month per
 * §5.1) and the Track-Order page (§2.8 track_page_config + S-31–S-38/S-49,
 * and the lookup throttle/abuse log behind S-38 and §5.7 control 4).
 *
 * tracking_event_raw carries ADD-18's parse result (accepted / duplicate /
 * unmapped status / signature failure) — the last-20-payloads debugging view
 * reads it.
 *
 * Partitioned tables cannot hold the §2.5 dedupe unique key without the
 * partition column; dedupe is enforced in the ingest transaction (check +
 * advisory lock on the dedupe key), documented here.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §3.31 tracking_event_raw.source
    CREATE TYPE tracking_source AS ENUM ('WEBHOOK', 'POLL');

    -- ADD-18: what the ingest pipeline did with a raw payload.
    CREATE TYPE tracking_parse_result AS ENUM (
      'ACCEPTED', 'DUPLICATE', 'UNMAPPED_STATUS', 'SIGNATURE_FAILURE',
      'AWB_QUARANTINED', 'PENDING'
    );

    -- §2.5 tracking_event_raw: every raw payload, appended always (A1-10),
    -- retained 30 days (§5.4). Partitioned by month on received_at.
    CREATE TABLE tracking_event_raw (
      raw_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      courier_account_id uuid REFERENCES courier_account (courier_account_id),
      awb_normalized text,                    -- null until resolved
      payload jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      source tracking_source NOT NULL,
      signature_valid boolean NOT NULL DEFAULT true,
      dedupe_hash text,
      parse_result tracking_parse_result NOT NULL DEFAULT 'PENDING',
      PRIMARY KEY (raw_event_id, received_at)
    ) PARTITION BY RANGE (received_at);
    CREATE INDEX tracking_raw_account_time
      ON tracking_event_raw (courier_account_id, received_at);
    CREATE INDEX tracking_raw_awb ON tracking_event_raw (shop_id, awb_normalized);
    CREATE TABLE tracking_event_raw_default PARTITION OF tracking_event_raw DEFAULT;

    CREATE OR REPLACE FUNCTION create_tracking_partition(p_table text, p_year int, p_month int)
    RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE
      start_date timestamptz := make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'UTC');
      end_date timestamptz := start_date + interval '1 month';
      part_name text := format('%s_%s_%s', p_table, p_year, lpad(p_month::text, 2, '0'));
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        part_name, p_table, start_date, end_date
      );
    END;
    $fn$;
    SELECT create_tracking_partition('tracking_event_raw', y, m)
      FROM generate_series(2026, 2027) AS y, generate_series(1, 12) AS m
      WHERE (y = 2026 AND m >= 7) OR (y = 2027 AND m <= 6);

    -- §2.5 tracking_event: the normalized timeline (§3.6), retained 24
    -- months (§5.4). review_flag: a late event after a terminal state
    -- (INV-17) or anything needing human eyes (INV-20) — stored and shown,
    -- never a silent state change.
    CREATE TABLE tracking_event (
      event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shipment_id uuid NOT NULL,
      carrier_event_status carrier_event_status,   -- null when unmapped (§3.6)
      raw_status text NOT NULL,
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      location_text text,
      reason_text text,
      provider_event_id text,
      dedupe_key text NOT NULL,
      review_flag boolean NOT NULL DEFAULT false,
      PRIMARY KEY (event_id, received_at)
    ) PARTITION BY RANGE (received_at);
    CREATE INDEX tracking_event_shipment
      ON tracking_event (shipment_id, occurred_at);
    CREATE INDEX tracking_event_review
      ON tracking_event (shop_id) WHERE review_flag;
    CREATE TABLE tracking_event_default PARTITION OF tracking_event DEFAULT;
    SELECT create_tracking_partition('tracking_event', y, m)
      FROM generate_series(2026, 2027) AS y, generate_series(1, 12) AS m
      WHERE (y = 2026 AND m >= 7) OR (y = 2027 AND m <= 6);

    -- §2.8 track_page_config (S-31–S-38, S-49). S-38's numbers are admin
    -- settings applied globally, not stored per shop.
    CREATE TABLE track_page_config (
      shop_id uuid PRIMARY KEY REFERENCES shop (shop_id),
      order_box_label text NOT NULL DEFAULT 'Order ID or AWB number',        -- S-31
      contact_box_label text NOT NULL DEFAULT 'Email or phone used on the order',  -- S-32
      theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),        -- S-33
      button_colour text NOT NULL DEFAULT '#0F6B6B',                         -- S-34 brand petrol teal
      show_courier_name boolean NOT NULL DEFAULT true,                       -- S-35
      show_item_summary boolean NOT NULL DEFAULT true,                       -- S-36
      replace_tracking_link boolean NOT NULL DEFAULT false,                  -- S-37
      logo_object_key text,                       -- S-49: null = inherit brand logo
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- S-38 + §9.16 + §5.7 control 4: throttle counting and abuse logging
    -- with salted hashes only — never raw identifiers or raw IPs.
    CREATE TABLE track_lookup_attempt (
      attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      ip_hash text NOT NULL,
      identifier_hash text,                   -- salted hash of order id / AWB
      success boolean NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX track_lookup_throttle
      ON track_lookup_attempt (shop_id, ip_hash, created_at);

    CREATE TRIGGER t BEFORE UPDATE ON track_page_config
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      track_page_config, track_lookup_attempt
      TO jsyxi_app;
    -- Raw payloads: content is append-only (§5.3); parse_result is processing
    -- bookkeeping and may be updated as the pipeline settles it.
    GRANT SELECT, INSERT, UPDATE ON tracking_event_raw TO jsyxi_app;
    GRANT SELECT, INSERT ON tracking_event TO jsyxi_app;
    GRANT USAGE ON TYPE tracking_source, tracking_parse_result TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS track_lookup_attempt, track_page_config,
      tracking_event, tracking_event_raw CASCADE;
    DROP FUNCTION IF EXISTS create_tracking_partition(text, int, int);
    DROP TYPE IF EXISTS tracking_parse_result, tracking_source;
  `);
};
