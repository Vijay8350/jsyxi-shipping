/**
 * Bootstrap the first PLATFORM_ADMIN (§10.3). Reads ADMIN_EMAIL and
 * ADMIN_PASSWORD from the environment; TOTP enrollment completes on first
 * login (the admin-auth flow is password-gated pre-session). Idempotent.
 *
 * Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:admin
 */
import 'dotenv/config';
import { Pool } from 'pg';
import argon2 from 'argon2';

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars) are required');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const hash = await argon2.hash(password);
    await pool.query(
      `INSERT INTO admin_user (email, password_hash, role)
       VALUES ($1, $2, 'PLATFORM_ADMIN')
       ON CONFLICT (email) DO NOTHING`,
      [email, hash],
    );
    console.log(`PLATFORM_ADMIN seeded: ${email} (TOTP enrollment on first login)`);
  } finally {
    await pool.end();
  }
}

void main();
