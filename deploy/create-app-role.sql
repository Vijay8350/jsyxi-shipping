-- Jsyxi Shipping — database + least-privilege runtime role.
--
-- The RDS instance is VPC-private, so run this ON THE EC2 BOX (a workstation
-- psql will time out). Pass the password in rather than editing this file, so
-- no credential is ever committed:
--
--   psql "postgres://<OWNER_USER>:<OWNER_PASSWORD>@my-app-postgres.ctiwq4cm6blm.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require" \
--     -v app_password="$(grep -oP '(?<=jsyxi_app:)[^@]+' /srv/jsyxi-shipping/shared/.env | head -1)" \
--     -f create-app-role.sql
--
-- That -v expression lifts the password straight out of DATABASE_APP_URL in the
-- deployed .env, so the two can never drift apart.
--
-- Why two roles (§6): the spec enforces append-only/immutable/sealed at the
-- DATABASE level, not just in application code. That only means anything if the
-- app's own connection physically lacks UPDATE/DELETE on those tables. The
-- migration owner holds DDL; jsyxi_app holds the narrowest possible runtime grant.

\if :{?app_password}
\else
  \echo 'ERROR: pass the app role password with -v app_password=...'
  \quit 1
\endif

-- Step 1: the database. UTF8 is required — migrations contain Unicode.
-- (CREATE DATABASE cannot run inside a transaction; \gexec handles this.)
SELECT 'CREATE DATABASE jsyxi TEMPLATE template0 ENCODING ''UTF8'''
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jsyxi')\gexec

-- Step 2: the runtime role. Idempotent — safe to re-run to rotate the password.
SELECT format(
  CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = 'jsyxi_app')
       THEN 'ALTER ROLE jsyxi_app LOGIN PASSWORD %L'
       ELSE 'CREATE ROLE jsyxi_app LOGIN PASSWORD %L'
  END, :'app_password')\gexec

-- Step 3: connect privilege. Everything else is granted by the migrations
-- themselves (migrations/0002, 0003, 0006… GRANT ... TO jsyxi_app by name),
-- which is why this file deliberately stops here — table-level grants are the
-- migrations' job so they stay in lockstep with the schema.
\connect jsyxi

GRANT CONNECT ON DATABASE jsyxi TO jsyxi_app;
GRANT USAGE ON SCHEMA public TO jsyxi_app;

-- Sanity check: the role exists and can neither create databases nor roles.
SELECT rolname, rolcanlogin, rolcreatedb, rolcreaterole, rolsuper
  FROM pg_roles WHERE rolname = 'jsyxi_app';
