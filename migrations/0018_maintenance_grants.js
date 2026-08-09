/**
 * 0018 — privileges for the §5.4 retention sweep and the §9.5.7/§5.3
 * test-shipment purge (both in the maintenance module).
 *
 * DELETE is granted on the carve-out and retention tables. Partition
 * DETACH/DROP additionally requires table ownership in PostgreSQL — the
 * retention sweep's partition-drop path therefore runs only when the
 * connecting role owns the tables (ops choice: point the maintenance
 * connection at the owner role); under the least-privilege app role the
 * sweep uses its bounded row-delete path.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §5.3 carve-out + §5.4 sweep targets. These were INSERT-only or
    -- no-DELETE in earlier migrations; the maintenance module's deletes are
    -- the ONLY sanctioned writers (Owner-initiated test purge, scheduled
    -- retention sweep) and both audit per §12.
    GRANT DELETE ON booking_intent TO jsyxi_app;      -- §5.3 carve-out
    GRANT DELETE ON tracking_event_raw TO jsyxi_app;  -- 30-day horizon
    GRANT DELETE ON tracking_event TO jsyxi_app;      -- 24-month horizon
    GRANT DELETE ON ndr_action TO jsyxi_app;          -- §5.3 carve-out child
    GRANT DELETE ON ndr_buyer_response, ndr_response_token TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    REVOKE DELETE ON booking_intent, tracking_event_raw, tracking_event,
      ndr_action, ndr_buyer_response, ndr_response_token FROM jsyxi_app;
  `);
};
