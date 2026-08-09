/**
 * 0017 — weeks 15–16 schema: tickets (§2.8, §3.16), announcements &
 * feedback (§3.29), admin staff + support context (§10.3, A1-07 — implied
 * entities, RW-11 pattern), ADD-29 setup health, ADD-33 per-screen guides.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- §3.16
    CREATE TYPE ticket_state AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
    CREATE TYPE ticket_category AS ENUM ('COURIER_ISSUE', 'BILLING', 'BUG', 'FEATURE', 'OTHER');
    CREATE TYPE ticket_priority AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

    -- §3.29 ANNOUNCEMENT_AUDIENCE + §3.31 announcement.type
    CREATE TYPE announcement_audience AS ENUM ('ALL', 'BY_PLAN', 'SPECIFIC_SHOPS');
    CREATE TYPE announcement_type AS ENUM ('INFO', 'WARNING', 'UPDATE');

    -- §10.3 admin roles
    CREATE TYPE admin_role AS ENUM ('PLATFORM_ADMIN', 'SUPPORT_AGENT', 'PLATFORM_FINANCE');

    -- ADD-29 item states
    CREATE TYPE setup_health_state AS ENUM ('OK', 'MISSING', 'BROKEN');

    CREATE TABLE ticket (
      ticket_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      number text NOT NULL,                     -- §13.5: TKT-{seq} per Shop
      category ticket_category NOT NULL DEFAULT 'OTHER',
      priority ticket_priority NOT NULL DEFAULT 'NORMAL',
      subject text NOT NULL,
      state ticket_state NOT NULL DEFAULT 'OPEN',
      assigned_admin_id uuid,
      linked_order_id uuid REFERENCES "order" (order_id),
      linked_awb text,
      created_at timestamptz NOT NULL DEFAULT now(),
      first_response_at timestamptz,
      resolved_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop_id, number)
    );

    CREATE TABLE ticket_message (
      message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid NOT NULL REFERENCES ticket (ticket_id),
      author_kind audit_actor_kind NOT NULL CHECK (author_kind IN ('MEMBER', 'ADMIN')),
      author_id uuid NOT NULL,
      body text NOT NULL,                       -- ≤10,000 chars (RW-13)
      attachments jsonb NOT NULL DEFAULT '[]',  -- §5.1: 5 files × 10 MB
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ticket_message_ticket ON ticket_message (ticket_id, created_at);

    CREATE TABLE announcement (                                -- [global]
      announcement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      body text NOT NULL,
      type announcement_type NOT NULL DEFAULT 'INFO',
      audience_kind announcement_audience NOT NULL DEFAULT 'ALL',
      audience_ref jsonb,             -- RW-17: plan code or Shop ID list; MUST be null for ALL
      published_at timestamptz,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (audience_kind <> 'ALL' OR audience_ref IS NULL)
    );

    CREATE TABLE announcement_read (
      read_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      announcement_id uuid NOT NULL REFERENCES announcement (announcement_id),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      member_id uuid NOT NULL,
      read_at timestamptz,
      dismissed_at timestamptz,
      UNIQUE (announcement_id, member_id)
    );

    CREATE TABLE feedback (
      feedback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      member_id uuid NOT NULL,
      rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment text,
      screenshot_object_key text,               -- §5.1: 1 PNG/JPEG × 10 MB
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- §10.3 admin staff (MFA-backed RBAC — TOTP mandatory like OVR-1).
    CREATE TABLE admin_user (                                  -- [global]
      admin_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      totp_secret_encrypted bytea,
      totp_confirmed boolean NOT NULL DEFAULT false,
      role admin_role NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE admin_session (                               -- [global]
      session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id uuid NOT NULL REFERENCES admin_user (admin_id),
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      invalidated_at timestamptz
    );

    -- A1-07 / §10.3: time-limited, reason- or ticket-bound, read-only admin
    -- context over one Shop. Never reveals credentials, never writes, never
    -- exports PII; fully audited (§12).
    CREATE TABLE support_context (                             -- [global]
      context_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      admin_id uuid NOT NULL REFERENCES admin_user (admin_id),
      ticket_id uuid REFERENCES ticket (ticket_id),
      reason text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      ended_at timestamptz,
      CHECK (ticket_id IS NOT NULL OR reason IS NOT NULL)
    );

    -- ADD-29: the computed, stored per-Shop setup-health object. The item
    -- catalog (deep links, labels) lives in code; each row carries state +
    -- first-detected timestamp.
    CREATE TABLE setup_health_item (
      shop_id uuid NOT NULL REFERENCES shop (shop_id),
      item_key text NOT NULL,
      state setup_health_state NOT NULL,
      detail text,
      first_detected_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (shop_id, item_key)
    );

    -- ADD-33: per-screen help videos + docs, admin-managed, live instantly.
    CREATE TABLE screen_guide (                                -- [global]
      guide_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      surface_key text NOT NULL UNIQUE,       -- e.g. 'rules', 'rate_cards', 'reconciliation'
      video_url text,
      doc_text text,
      updated_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TRIGGER t BEFORE UPDATE ON ticket FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON admin_user FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE TRIGGER t BEFORE UPDATE ON screen_guide FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ticket, ticket_message, announcement, announcement_read, feedback,
      admin_user, admin_session, support_context, setup_health_item, screen_guide
      TO jsyxi_app;
    GRANT USAGE ON TYPE
      ticket_state, ticket_category, ticket_priority, announcement_audience,
      announcement_type, admin_role, setup_health_state
      TO jsyxi_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS screen_guide, setup_health_item, support_context,
      admin_session, admin_user, feedback, announcement_read, announcement,
      ticket_message, ticket;
    DROP TYPE IF EXISTS setup_health_state, admin_role, announcement_type,
      announcement_audience, ticket_priority, ticket_category, ticket_state;
  `);
};
