/**
 * 0009 — fix the INV-19 guard: `is_test` is SET from the courier account's
 * mode at booking (the CONFIRMED write, §3.2) and immutable THEREAFTER
 * (INV-19). The 0003 trigger raised on any change, including that first set.
 * Now: exactly one transition false → <value> at the CONFIRMED write is
 * permitted; every later change raises.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION guard_shipment_row() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      -- INV-10 (RV-05): the snapshot changes only at DRAFT → QUEUED — the
      -- initial freeze, and the re-freeze on a new booking attempt (§2.9).
      IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
         AND NOT (OLD.booking_state = 'DRAFT' AND NEW.booking_state = 'QUEUED') THEN
        RAISE EXCEPTION 'INV-10: shipment.snapshot changes only at DRAFT → QUEUED';
      END IF;
      -- INV-19: set once from the courier account mode at the CONFIRMED
      -- write; immutable before and after.
      IF NEW.is_test IS DISTINCT FROM OLD.is_test
         AND NOT (OLD.is_test = false AND NEW.booking_state = 'CONFIRMED') THEN
        RAISE EXCEPTION 'INV-19: shipment.is_test is set at booking and immutable thereafter';
      END IF;
      -- §10.4: working values are freely editable only while DRAFT or
      -- NEEDS_MANUAL_ASSIGNMENT.
      IF NEW.working_values IS DISTINCT FROM OLD.working_values
         AND NEW.booking_state NOT IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT') THEN
        RAISE EXCEPTION '§10.4: working values are frozen from QUEUED onward';
      END IF;
      RETURN NEW;
    END;
    $fn$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION guard_shipment_row() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
         AND NOT (OLD.booking_state = 'DRAFT' AND NEW.booking_state = 'QUEUED') THEN
        RAISE EXCEPTION 'INV-10: shipment.snapshot changes only at DRAFT → QUEUED';
      END IF;
      IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
        RAISE EXCEPTION 'INV-19: shipment.is_test is immutable';
      END IF;
      IF NEW.working_values IS DISTINCT FROM OLD.working_values
         AND NEW.booking_state NOT IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT') THEN
        RAISE EXCEPTION '§10.4: working values are frozen from QUEUED onward';
      END IF;
      RETURN NEW;
    END;
    $fn$;
  `);
};
