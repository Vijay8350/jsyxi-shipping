/**
 * 0019 — partition helpers as SECURITY DEFINER. The maintenance module's
 * partition creation (§5.1) runs as the least-privilege app role, which has
 * no CREATE rights; the helpers now execute with the definer's (owner's)
 * privileges. They only ever CREATE TABLE ... PARTITION OF with a
 * format-derived name — no caller-controlled identifiers.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION create_shipment_partition(p_year int, p_month int)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE
      start_date date := make_date(p_year, p_month, 1);
      end_date date := make_date(p_year, p_month, 1) + interval '1 month';
      part_name text := format('shipment_%s_%s', p_year, lpad(p_month::text, 2, '0'));
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF shipment FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date
      );
    END;
    $fn$;

    CREATE OR REPLACE FUNCTION create_tracking_partition(p_table text, p_year int, p_month int)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE
      start_date timestamptz := make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'UTC');
      end_date timestamptz := start_date + interval '1 month';
      part_name text := format('%s_%s_%s', p_table, p_year, lpad(p_month::text, 2, '0'));
    BEGIN
      -- p_table is validated against the two partitioned tables before use.
      IF p_table NOT IN ('tracking_event_raw', 'tracking_event') THEN
        RAISE EXCEPTION 'unknown partitioned table: %', p_table;
      END IF;
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        part_name, p_table, start_date, end_date
      );
    END;
    $fn$;

    GRANT EXECUTE ON FUNCTION create_shipment_partition(int, int) TO jsyxi_app;
    GRANT EXECUTE ON FUNCTION create_tracking_partition(text, int, int) TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION create_shipment_partition(p_year int, p_month int)
    RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE
      start_date date := make_date(p_year, p_month, 1);
      end_date date := make_date(p_year, p_month, 1) + interval '1 month';
      part_name text := format('shipment_%s_%s', p_year, lpad(p_month::text, 2, '0'));
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        part_name, 'shipment', start_date, end_date
      );
    END;
    $fn$;
    REVOKE EXECUTE ON FUNCTION create_shipment_partition(int, int) FROM jsyxi_app;
    REVOKE EXECUTE ON FUNCTION create_tracking_partition(text, int, int) FROM jsyxi_app;
  `);
};
