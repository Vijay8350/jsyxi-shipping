/**
 * 0008 — weeks 6–8 schema: quote cache (§2.4, §4.5), Shopify sync-back
 * outbox (§2.8, §8.4), documents (§2.6 — manifests land in this block;
 * labels reuse the same tables later), and the bulk-booking batch record
 * (§9.5.2 implies it; RW-11 pattern — an implied entity the settled
 * behaviour requires).
 *
 * S-22 (default chain when no rule matches) gains its home on
 * order_sync_settings: an ordered list of merchant_service ids, NULL = unset
 * at day one (RW-22 — a no-rule shipment goes to NEEDS_MANUAL_ASSIGNMENT,
 * never to an arbitrary service).
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §3.31 quote.edd_source
    CREATE TYPE edd_source AS ENUM ('PROVIDER', 'RATE_CARD_SLA');

    -- §3.31 sync_outbox.operation
    CREATE TYPE sync_operation AS ENUM (
      'CREATE_FULFILLMENT', 'ADD_FULFILLMENT_EVENT', 'CANCEL_FULFILLMENT',
      'SET_ORDER_TAGS'
    );

    -- §3.17 SYNC_STATE
    CREATE TYPE sync_state AS ENUM (
      'PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'RETRYING', 'DEAD'
    );

    -- §3.31 document.kind / document_job.kind
    CREATE TYPE document_kind AS ENUM (
      'LABEL', 'MANIFEST', 'INVOICE', 'PACKING_SLIP', 'BULK_LABEL'
    );

    -- §3.27 JOB_STATE
    CREATE TYPE job_state AS ENUM (
      'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'
    );

    -- §2.4 quote. Source is a rate card version or a live provider call
    -- (A2-02). Also the §4.5 live-quote cache: key (service, origin,
    -- destination, billable-weight band, payment mode) with TTL S-16.
    CREATE TABLE quote (
      quote_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      shipment_id uuid,                       -- null for pre-booking estimates
      courier_account_id uuid REFERENCES courier_account (courier_account_id),
      service_id uuid NOT NULL REFERENCES service (service_id),
      cost_source cost_source NOT NULL,
      rate_card_version_id uuid REFERENCES rate_card_version (rate_card_version_id),
      zone_map_id uuid REFERENCES commercial_zone_map (zone_map_id),
      provider_quote_ref text,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,                 -- S-16 TTL for LIVE_QUOTE cache
      components_json jsonb NOT NULL,         -- §8.3 itemized components
      total numeric(19,4) CHECK (total >= 0),
      currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      edd_from date,
      edd_to date,
      edd_source edd_source,
      -- Cache-key columns (§4.5)
      origin_pincode text,
      destination_pincode text,
      billable_weight_band numeric(10,3),
      payment_mode payment_mode,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX quote_cache_key ON quote
      (service_id, origin_pincode, destination_pincode, billable_weight_band,
       payment_mode, fetched_at)
      WHERE shipment_id IS NULL;

    -- §2.8 sync_outbox: every Shopify write goes through here (§8.4); retries
    -- per S-48, then Shop-scoped DLQ with an alert; DEAD exits only via an
    -- audited admin replay (A1-10).
    CREATE TABLE sync_outbox (
      outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      order_id uuid NOT NULL REFERENCES "order" (order_id),
      shipment_id uuid,
      operation sync_operation NOT NULL,
      payload jsonb NOT NULL,
      state sync_state NOT NULL DEFAULT 'PENDING',
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      -- (shop_id, shipment_id, operation, attempt-invariant digest) (§8.4):
      -- a repeat never creates a second fulfillment.
      idempotency_key text NOT NULL UNIQUE,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sync_outbox_pending ON sync_outbox (state, next_attempt_at);

    -- §2.6 documents. Storage is S3-compatible object storage (§9.9.1); the
    -- object key is shop-scoped (INV-1). Signed URLs per S-26 (10 minutes).
    CREATE TABLE document (
      document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      kind document_kind NOT NULL,
      shipment_id uuid,
      object_key text NOT NULL,
      sha256 text NOT NULL,
      bytes integer NOT NULL CHECK (bytes >= 0),
      generated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,                 -- retention per §5.4
      is_test boolean NOT NULL DEFAULT false  -- inherited from its Shipment (INV-19)
    );
    CREATE INDEX document_shipment ON document (shipment_id);

    CREATE TABLE document_job (
      job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      kind document_kind NOT NULL,
      requested_by uuid,
      filters jsonb,
      state job_state NOT NULL DEFAULT 'QUEUED',
      progress jsonb NOT NULL DEFAULT '{}',
      result_document_id uuid REFERENCES document (document_id),
      skipped_report jsonb,                   -- §9.9.1 PARTIAL case
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- §9.5.2 bulk booking: up to 1,000 orders per job, asynchronous with live
    -- progress and a per-order result. A bulk job snapshots rule, Service,
    -- capability and rate-card versions at enqueue time (§9.4.5, A1-10).
    CREATE TABLE booking_batch (
      batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      requested_by uuid,
      state job_state NOT NULL DEFAULT 'QUEUED',
      total integer NOT NULL CHECK (total > 0 AND total <= 1000),
      processed integer NOT NULL DEFAULT 0,
      succeeded integer NOT NULL DEFAULT 0,
      failed integer NOT NULL DEFAULT 0,
      results jsonb NOT NULL DEFAULT '[]',    -- per-order: ✓ AWB / ✗ exact error (INV-20)
      version_snapshot jsonb,                 -- §9.4.5 enqueue-time versions
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- S-22 (§7.3, RW-22): the default chain when no rule matches. Ordered
    -- merchant_service ids; NULL = unset at day one.
    ALTER TABLE order_sync_settings
      ADD COLUMN default_chain jsonb;

    CREATE TRIGGER t BEFORE UPDATE ON sync_outbox FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON document_job FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON booking_batch FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      quote, sync_outbox, document, document_job, booking_batch
      TO jsyxi_app;
    GRANT USAGE ON TYPE
      edd_source, sync_operation, sync_state, document_kind, job_state
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE order_sync_settings DROP COLUMN IF EXISTS default_chain;
    DROP TABLE IF EXISTS booking_batch, document_job, document, sync_outbox, quote;
    DROP TYPE IF EXISTS job_state, document_kind, sync_state, sync_operation, edd_source;
  `);
};
