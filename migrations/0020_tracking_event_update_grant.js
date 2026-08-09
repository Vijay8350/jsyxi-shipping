/**
 * 0020 — grant UPDATE on tracking_event to the app role. The §3.4 reducer's
 * INV-17 review flag is an UPDATE (review_flag is processing bookkeeping,
 * like parse_result on the raw table — event content stays append-only,
 * §5.3). Live e2e proved the worker (jsyxi_app) needs it: BullMQ jobs failed
 * with "permission denied for table tracking_event" after inserting the
 * event, leaving the raw stuck PENDING and a retry flipping it to DUPLICATE.
 */

exports.up = (pgm) => {
  pgm.sql(`
    GRANT UPDATE ON tracking_event TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    REVOKE UPDATE ON tracking_event FROM jsyxi_app;
  `);
};
