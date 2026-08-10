export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY ?? '',
    apiSecret: process.env.SHOPIFY_API_SECRET ?? '',
    scopes: (process.env.SHOPIFY_SCOPES ?? '').split(',').filter(Boolean),
    appUrl: process.env.APP_URL ?? 'http://localhost:3000',
    apiUrl: process.env.API_URL ?? 'http://localhost:3000',
  },
  crypto: {
    masterKeyHex: process.env.MASTER_KEY_HEX ?? '',
    piiHashSalt: process.env.PII_HASH_SALT ?? '',
  },
  session: {
    // RW-04: 12 hours of inactivity.
    ttlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 43200),
  },
  admin: {
    /**
     * §10.3 mandates MFA for staff, so this DEFAULTS TO TRUE and stays true
     * unless an operator explicitly opts out with ADMIN_REQUIRE_TOTP=false.
     *
     * Turning it off is a real reduction in protection: the staff console can
     * read every merchant's orders, tickets and PII, so a leaked staff
     * password becomes sufficient on its own. It exists because the operator
     * asked for password-only access with that tradeoff understood — an
     * already-enrolled admin still has their code verified either way.
     */
    requireTotp: String(process.env.ADMIN_REQUIRE_TOTP ?? 'true').toLowerCase() !== 'false',
  },
  // Internal service-to-service token (team module InternalTokenGuard).
  internalToken: process.env.JSYXI_INTERNAL_TOKEN ?? '',
  // Documents (§9.9.1): object storage root + S-26 signed-URL secret.
  objectStoreDir: process.env.OBJECT_STORE_DIR ?? './var/objects',
  documentSigningSecret: process.env.DOCUMENT_SIGNING_SECRET ?? '',
});
