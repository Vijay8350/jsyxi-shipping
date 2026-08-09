/**
 * 0007 — courier_api_call: §8.2 transport policy requires that every adapter
 * request and response is recorded with secrets masked (INV-18). No §2
 * entity names it; this table is that record. Summaries only — never full
 * payloads, never credentials, never recipient PII (§5.7 control 4).
 * Retention: 30 days, with the raw webhook payloads (§5.4).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE courier_api_call (
      call_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      courier_account_id uuid NOT NULL REFERENCES courier_account (courier_account_id),
      method text NOT NULL,               -- §8.2 method name
      shipment_id uuid,                   -- when the call concerns a shipment
      request_summary jsonb,              -- masked summary, never raw payload
      response_summary jsonb,
      outcome text NOT NULL,              -- SUCCESS | FAILED | TIMEOUT | CIRCUIT_OPEN
      duration_ms integer,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX courier_api_call_account_time
      ON courier_api_call (courier_account_id, created_at);
    SELECT make_append_only('courier_api_call');

    GRANT SELECT, INSERT ON courier_api_call TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS courier_api_call;`);
};
