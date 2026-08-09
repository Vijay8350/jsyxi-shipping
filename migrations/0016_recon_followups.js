/**
 * 0016 — weeks 14–15 follow-ups:
 * - §3.25: PROVIDER_CONFIRMED_CHARGE persists the provider's confirmed
 *   charge on the shipment (the booking worker decided the basis but had no
 *   column for the amount) — §4.8 FORWARD expectations read it.
 * - INV-20: unmatched remittance AWBs on a COD batch are surfaced with a
 *   count and a list, never silently dropped.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE shipment
      ADD COLUMN provider_confirmed_charge numeric(19,4)
        CHECK (provider_confirmed_charge >= 0);

    ALTER TABLE recon_cod_batch
      ADD COLUMN matched_count integer NOT NULL DEFAULT 0,
      ADD COLUMN unmatched_count integer NOT NULL DEFAULT 0,
      ADD COLUMN unmatched_json jsonb NOT NULL DEFAULT '[]';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE shipment DROP COLUMN IF EXISTS provider_confirmed_charge;
    ALTER TABLE recon_cod_batch
      DROP COLUMN IF EXISTS matched_count,
      DROP COLUMN IF EXISTS unmatched_count,
      DROP COLUMN IF EXISTS unmatched_json;
  `);
};
