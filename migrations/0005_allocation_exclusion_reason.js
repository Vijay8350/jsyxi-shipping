/**
 * 0005 — allocation.exclusion_reason (§3.22, INV-20): an EXCLUDED allocation
 * is shown on the order WITH its reason, never silently absent.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE allocation ADD COLUMN exclusion_reason text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE allocation DROP COLUMN IF EXISTS exclusion_reason;
  `);
};
