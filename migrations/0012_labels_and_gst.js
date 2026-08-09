/**
 * 0012 — weeks 9–11 schema: label template (§2.6, S-23/S-24) and the GST
 * invoice model (§2.6, §3.12, §9.9.2, INV-13).
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §3.12 INVOICE_STATE
    CREATE TYPE invoice_state AS ENUM ('ISSUE_PENDING', 'ISSUED', 'VOID');

    -- §2.6 label_template (S-23 size, S-24 toggles; the COD amount is always
    -- emphasized and is NOT a toggle). One per Shop at v1 (§9.12).
    CREATE TABLE label_template (
      template_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL UNIQUE REFERENCES shop (shop_id),
      logo_object_key text,
      brand_name text,
      support_phone text,
      message_line text,
      -- S-24 defaults: product list on, SKU on, order barcode on, GST number
      -- on, weight/dims on, routing code on, prices off, hide amounts on
      -- prepaid on.
      toggles jsonb NOT NULL DEFAULT '{
        "productList": true, "sku": true, "orderBarcode": true,
        "gstNumber": true, "weightDims": true, "routingCode": true,
        "prices": false, "hideAmountsOnPrepaid": true
      }',
      size text NOT NULL DEFAULT 'THERMAL_4X6'
        CHECK (size IN ('THERMAL_4X6', 'A4_1UP', 'A4_2UP', 'A4_4UP')),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- §2.6 gst_invoice: one immutable invoice per Order (A1-08/A3-02), one
    -- GST registration per Shop at v1 (§9.9.2). The number is allocated ONLY
    -- on ISSUED (INV-13); corrections are linked void/credit/debit records,
    -- never edits (INV-16).
    CREATE TABLE gst_invoice (
      invoice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      order_id uuid NOT NULL REFERENCES "order" (order_id),
      state invoice_state NOT NULL DEFAULT 'ISSUE_PENDING',
      series_code text NOT NULL DEFAULT 'INV',        -- S-25
      invoice_number text,                            -- allocated at ISSUED only
      financial_year text,                            -- e.g. '2026-27' (A1-11)
      issued_at timestamptz,
      seller_snapshot jsonb,                          -- legal snapshot at issue
      buyer_snapshot jsonb,
      place_of_supply text,
      totals jsonb,
      currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      -- §9.9.2: missing fields are listed on the invoice (and surfaced as a
      -- dashboard card / report filter); booking never blocks on them (A2-07).
      missing_fields jsonb NOT NULL DEFAULT '[]',
      void_of_invoice_id uuid REFERENCES gst_invoice (invoice_id),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, order_id)
    );

    CREATE TABLE gst_invoice_line (
      invoice_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid NOT NULL REFERENCES gst_invoice (invoice_id),
      order_line_id uuid REFERENCES order_line (order_line_id),
      hsn_code text,
      quantity integer NOT NULL CHECK (quantity > 0),
      taxable_value numeric(19,4) NOT NULL CHECK (taxable_value >= 0),
      tax_components jsonb NOT NULL DEFAULT '[]',
      line_total numeric(19,4) NOT NULL CHECK (line_total >= 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX gst_invoice_line_invoice ON gst_invoice_line (invoice_id);

    -- INV-13: numbers allocated atomically per (shop, gstin, financial year,
    -- series); never reused; gaps arise only from voids.
    CREATE TABLE invoice_number_sequence (
      sequence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      gstin text NOT NULL,
      financial_year text NOT NULL,
      series_code text NOT NULL,
      next_number integer NOT NULL DEFAULT 1 CHECK (next_number > 0),
      UNIQUE (shop_id, gstin, financial_year, series_code)
    );

    CREATE TRIGGER t BEFORE UPDATE ON label_template FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON gst_invoice FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      label_template, gst_invoice, gst_invoice_line, invoice_number_sequence
      TO jsyxi_app;
    GRANT USAGE ON TYPE invoice_state TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS invoice_number_sequence, gst_invoice_line,
      gst_invoice, label_template;
    DROP TYPE IF EXISTS invoice_state;
  `);
};
