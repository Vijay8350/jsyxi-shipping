/**
 * 0001 — helpers, enums and the append-only guard machinery.
 *
 * Conventions set here and reused by every later migration:
 * - Enum columns are PG enum types with the exact `spec.md` §3 value lists
 *   (RV-07 — no value is invented, none is left to application code).
 * - Append-only tables (§5.3) are enforced at the database level: a
 *   BEFORE UPDATE OR DELETE trigger that always raises, plus REVOKE of
 *   UPDATE/DELETE from the application role (Addendum A working rules).
 * - The application connects as `jsyxi_app`, a least-privilege role; the
 *   migration owner is the only role that can mutate guarded tables directly.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Least-privilege application role. Local dev: create it with a password
    -- first (see .env.example); this block only ensures the role exists.
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jsyxi_app') THEN
        CREATE ROLE jsyxi_app LOGIN;
      END IF;
    END
    $$;

    -- Append-only guard: any UPDATE or DELETE on a guarded table raises.
    CREATE OR REPLACE FUNCTION reject_append_only_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      RAISE EXCEPTION '% is append-only (spec.md §5.3, INV-16)', TG_TABLE_NAME;
    END;
    $fn$;

    -- Attach the guard to a table. Used by every migration that creates an
    -- append-only table.
    CREATE OR REPLACE FUNCTION make_append_only(p_table regclass)
    RETURNS void
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      EXECUTE format(
        'CREATE TRIGGER append_only_guard BEFORE UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation()',
        p_table
      );
      EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM jsyxi_app', p_table);
    END;
    $fn$;

    --------------------------------------------------------------------
    -- Enum types. Value lists are spec.md §3, verbatim (RV-07).
    --------------------------------------------------------------------

    -- §3.11 ACCOUNT_STATE / SUBSCRIPTION_STATE
    CREATE TYPE account_state AS ENUM (
      'TRIALING', 'ACTIVE', 'RESTRICTED', 'READ_ONLY', 'UNINSTALLED'
    );

    -- §10.1 seeded merchant roles. "No access" is the ABSENCE of a row
    -- (deny-by-default, §9.1.2), not an enum value.
    CREATE TYPE member_role AS ENUM ('OWNER', 'OPERATOR', 'FINANCE', 'VIEWER');

    -- Addendum A OVR-1: how a member authenticates.
    CREATE TYPE auth_source AS ENUM ('SHOPIFY_STAFF', 'NATIVE');

    -- §3.19 ACCESS_REQUEST_RESOLUTION
    CREATE TYPE access_request_resolution AS ENUM (
      'PENDING', 'GRANTED', 'DENIED', 'WITHDRAWN'
    );

    -- §3.31 awb_entitlement_ledger.direction
    CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'REVERSAL');

    -- §3.20 USAGE_RECORD_STATE
    CREATE TYPE usage_record_state AS ENUM (
      'PENDING', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'REVERSED'
    );

    -- §3.31 audit_log.actor_kind
    CREATE TYPE audit_actor_kind AS ENUM ('MEMBER', 'ADMIN', 'SYSTEM');

    -- §3.26 WEBHOOK_INBOX_STATE
    CREATE TYPE webhook_inbox_state AS ENUM (
      'RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'
    );

    -- §3.31 webhook_inbox.source
    CREATE TYPE webhook_source AS ENUM ('SHOPIFY', 'COURIER');

    -- §3.31 feature_flag.scope
    CREATE TYPE feature_flag_scope AS ENUM ('GLOBAL', 'SHOP');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TYPE IF EXISTS feature_flag_scope;
    DROP TYPE IF EXISTS webhook_source;
    DROP TYPE IF EXISTS webhook_inbox_state;
    DROP TYPE IF EXISTS audit_actor_kind;
    DROP TYPE IF EXISTS usage_record_state;
    DROP TYPE IF EXISTS ledger_direction;
    DROP TYPE IF EXISTS access_request_resolution;
    DROP TYPE IF EXISTS auth_source;
    DROP TYPE IF EXISTS member_role;
    DROP TYPE IF EXISTS account_state;
    DROP FUNCTION IF EXISTS make_append_only(regclass);
    DROP FUNCTION IF EXISTS reject_append_only_mutation();
  `);
};
