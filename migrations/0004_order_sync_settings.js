/**
 * 0004 — order-sync settings (S-8…S-14) and the day-one plan seed (§5.6).
 *
 * §2 names settings entities for store (§7.1), NDR, reconciliation and the
 * track page, but none for the §7.2 order-sync settings; this table is their
 * home, following the same per-Shop pattern as `ndr_settings` / `recon_settings`.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE order_sync_settings (
      shop_id uuid PRIMARY KEY REFERENCES shop (shop_id),
      auto_import boolean NOT NULL DEFAULT true,                    -- S-8
      notify_customer boolean NOT NULL DEFAULT true,                -- S-9
      auto_ship_enabled boolean NOT NULL DEFAULT false,             -- S-10
      auto_ship_hold_minutes integer NOT NULL DEFAULT 30
        CHECK (auto_ship_hold_minutes BETWEEN 0 AND 1440),          -- S-11 (0 min – 24 h, A3-03)
      auto_ship_cutoff_time time,                                   -- S-12
      auto_ship_sweep_cap integer NOT NULL DEFAULT 500
        CHECK (auto_ship_sweep_cap > 0),                            -- S-13 (A3-03)
      -- S-14: gateway names that mean COD. Seeded with common Indian COD
      -- gateway names; merchant-maintained thereafter (A1-03).
      cod_gateway_map jsonb NOT NULL DEFAULT
        '["Cash on Delivery (COD)", "Cash on Delivery", "COD", "cod", "cash_on_delivery"]',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TRIGGER t BEFORE UPDATE ON order_sync_settings
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON order_sync_settings TO jsyxi_app;

    -- §5.6 day one: the trial tier (S-39: 14 days, 50 AWBs). Paid tiers are
    -- admin-managed against Shopify Billing (§9.14) and are not seeded here.
    INSERT INTO plan (code, name, awb_allowance_per_cycle, price, currency,
                      overage_unit_price, is_trial, is_active)
    VALUES ('TRIAL', 'Trial', 50, 0, 'INR', 0, true, true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM plan WHERE code = 'TRIAL';
    DROP TABLE IF EXISTS order_sync_settings;
  `);
};
