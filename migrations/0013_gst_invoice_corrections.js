/**
 * 0013 — relax gst_invoice uniqueness for INV-16 corrections. §9.9.2: one
 * invoice per Order; corrections are NEW LINKED records (void / credit note),
 * never edits. A credit note shares the Order with the invoice it corrects,
 * so the blanket UNIQUE (shop_id, order_id) blocked it. The primary invoice
 * is now unique where void_of_invoice_id IS NULL; linked corrections are not.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE gst_invoice DROP CONSTRAINT IF EXISTS gst_invoice_shop_id_order_id_key;
    CREATE UNIQUE INDEX gst_invoice_one_primary_per_order
      ON gst_invoice (shop_id, order_id)
      WHERE void_of_invoice_id IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS gst_invoice_one_primary_per_order;
    ALTER TABLE gst_invoice
      ADD CONSTRAINT gst_invoice_shop_id_order_id_key UNIQUE (shop_id, order_id);
  `);
};
