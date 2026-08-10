/**
 * 0021 — an announcement may carry one image (§9.19).
 *
 * Stored as a URL rather than an uploaded object: an announcement is global
 * ([global] table, no shop_id), so it cannot live under the shop-scoped object
 * store or its shop-scoped signed URLs (S-26, INV-1) without inventing a
 * second serving path. A URL also lets staff reuse whatever CDN already hosts
 * their product imagery.
 *
 * Nullable and unconstrained in width: the value is rendered in an <img> by
 * the merchant console, which is why the APPLICATION restricts it to http(s)
 * — a `javascript:` or `data:` URL reaching an attribute would be a script
 * injection, and that check belongs where the value is accepted (the DTO), not
 * in a CHECK constraint that a later writer could bypass.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE announcement ADD COLUMN IF NOT EXISTS image_url text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE announcement DROP COLUMN IF EXISTS image_url;
  `);
};
