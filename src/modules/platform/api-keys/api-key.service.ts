import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../../database/database.module';
import { AuditService } from '../../../audit/audit.service';
import { randomToken, tokenHash } from '../../../common/crypto';

/**
 * Merchant REST API keys (ADD-20). The key model ships now; the v1 read-only
 * endpoints mount `ApiKeyGuard` later — this service is its backend.
 *
 * - Format: `jsx_live_` + 32 random base64url chars (192 bits of entropy).
 * - Only the SHA-256 hash is stored (INV-18); the plaintext is returned
 *   EXACTLY once, in the create/rotate response.
 * - Scopes are a non-empty subset of read-orders / book / track / reports
 *   (the DB CHECK enforces it too); per-key rate limit, key rotation and a
 *   throttled last-used timestamp are first-class (ADD-20).
 * - Create / rotate / revoke are always audited (§12).
 */

export const API_KEY_SCOPES = ['read-orders', 'book', 'track', 'reports'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_PREFIX = 'jsx_live_';
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
/** last_used_at is written at most once per minute per key. */
export const LAST_USED_TOUCH_MS = 60_000;

export interface ApiKeyView {
  keyId: string;
  shopId: string;
  name: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
  lastUsedAt: string | null;
  rotatedFromKeyId: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  version: number;
}

/** What `verify` resolves and `ApiKeyGuard` attaches to the request. */
export interface ResolvedApiKey {
  keyId: string;
  shopId: string;
  name: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
}

interface ApiKeyRow {
  key_id: string;
  shop_id: string;
  name: string;
  scopes: string[];
  rate_limit_per_minute: number;
  last_used_at: string | null;
  rotated_from_key_id: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  version: number;
}

// key_hash is deliberately never selected into a view — the hash is useless
// to the UI and plaintext is never stored (INV-18).
const VIEW_COLUMNS = `key_id, shop_id, name, scopes, rate_limit_per_minute,
  last_used_at, rotated_from_key_id, revoked_at, created_by, created_at, version`;

function toView(row: ApiKeyRow): ApiKeyView {
  return {
    keyId: row.key_id,
    shopId: row.shop_id,
    name: row.name,
    scopes: row.scopes as ApiKeyScope[],
    rateLimitPerMinute: row.rate_limit_per_minute,
    lastUsedAt: row.last_used_at,
    rotatedFromKeyId: row.rotated_from_key_id,
    revokedAt: row.revoked_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    version: row.version,
  };
}

function validateScopes(scopes: unknown): asserts scopes is ApiKeyScope[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some(
      (s) => !(API_KEY_SCOPES as readonly string[]).includes(String(s)),
    )
  ) {
    throw new BadRequestException(
      `scopes must be a non-empty subset of ${API_KEY_SCOPES.join(', ')} (ADD-20)`,
    );
  }
}

@Injectable()
export class ApiKeyService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create a key. The plaintext is returned EXACTLY once here; only its
   * hash is stored.
   */
  async create(input: {
    shopId: string;
    name: string;
    scopes: ApiKeyScope[];
    rateLimitPerMinute?: number;
    createdBy: string;
  }): Promise<{ plaintext: string; key: ApiKeyView }> {
    if (!input.name || !input.name.trim()) {
      throw new BadRequestException('name is required');
    }
    validateScopes(input.scopes);
    const rateLimit = input.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    if (!Number.isInteger(rateLimit) || rateLimit <= 0) {
      throw new BadRequestException('rateLimitPerMinute must be a positive integer');
    }

    const plaintext = API_KEY_PREFIX + randomToken(24); // 32 base64url chars
    const result = await this.pool.query<ApiKeyRow>(
      `INSERT INTO api_key
         (shop_id, name, key_hash, scopes, rate_limit_per_minute, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${VIEW_COLUMNS}`,
      [
        input.shopId,
        input.name.trim(),
        tokenHash(plaintext),
        input.scopes,
        rateLimit,
        input.createdBy,
      ],
    );
    const key = toView(result.rows[0]);
    // §12, ADD-20: key creation is audited (never the plaintext or hash).
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.createdBy,
      action: 'api_key.create',
      objectType: 'api_key',
      objectId: key.keyId,
      after: { name: key.name, scopes: key.scopes, rateLimitPerMinute: key.rateLimitPerMinute },
    });
    return { plaintext, key };
  }

  /**
   * Resolve a presented key by hash. Revoked keys are rejected. On success
   * last_used_at is touched at most once per minute per key — a compare
   * check against the row we already read, so the verify hot path does not
   * depend on Redis (ADD-20).
   */
  async verify(plaintext: string): Promise<ResolvedApiKey | null> {
    if (!plaintext || !plaintext.startsWith(API_KEY_PREFIX)) return null;
    const result = await this.pool.query<
      ApiKeyRow & { last_used_at: string | null }
    >(
      `SELECT ${VIEW_COLUMNS} FROM api_key WHERE key_hash = $1`,
      [tokenHash(plaintext)],
    );
    const row = result.rows[0];
    if (!row || row.revoked_at) return null;

    const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
    if (Date.now() - lastUsed >= LAST_USED_TOUCH_MS) {
      await this.pool.query(
        `UPDATE api_key SET last_used_at = now() WHERE key_id = $1`,
        [row.key_id],
      );
    }
    return {
      keyId: row.key_id,
      shopId: row.shop_id,
      name: row.name,
      scopes: row.scopes as ApiKeyScope[],
      rateLimitPerMinute: row.rate_limit_per_minute,
    };
  }

  hasScope(resolved: ResolvedApiKey, scope: ApiKeyScope): boolean {
    return resolved.scopes.includes(scope);
  }

  /** List the shop's keys (never the hash). Shop-scoped (INV-1). */
  async list(shopId: string): Promise<ApiKeyView[]> {
    const result = await this.pool.query<ApiKeyRow>(
      `SELECT ${VIEW_COLUMNS} FROM api_key
        WHERE shop_id = $1
        ORDER BY created_at DESC`,
      [shopId],
    );
    return result.rows.map(toView);
  }

  /**
   * Rotate: create a successor carrying `rotated_from_key_id`, revoke the
   * old key, return the new plaintext exactly once (ADD-20).
   */
  async rotate(
    keyId: string,
    shopId: string,
    actorId: string,
  ): Promise<{ plaintext: string; key: ApiKeyView }> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<ApiKeyRow>(
        `SELECT ${VIEW_COLUMNS} FROM api_key
          WHERE key_id = $1 AND shop_id = $2
          FOR UPDATE`,
        [keyId, shopId],
      );
      const old = current.rows[0];
      if (!old) throw new NotFoundException('api key not found');
      if (old.revoked_at) {
        throw new BadRequestException('cannot rotate a revoked key');
      }

      const plaintext = API_KEY_PREFIX + randomToken(24);
      const successor = await client.query<ApiKeyRow>(
        `INSERT INTO api_key
           (shop_id, name, key_hash, scopes, rate_limit_per_minute,
            rotated_from_key_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${VIEW_COLUMNS}`,
        [
          shopId,
          old.name,
          tokenHash(plaintext),
          old.scopes,
          old.rate_limit_per_minute,
          old.key_id,
          actorId,
        ],
      );
      await client.query(
        `UPDATE api_key
            SET revoked_at = now(), version = version + 1
          WHERE key_id = $1`,
        [old.key_id],
      );
      await client.query('COMMIT');

      const key = toView(successor.rows[0]);
      // §12, ADD-20: rotation is audited.
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId,
        action: 'api_key.rotate',
        objectType: 'api_key',
        objectId: old.key_id,
        before: { name: old.name, scopes: old.scopes },
        after: { successorKeyId: key.keyId, revokedAt: 'now' },
      });
      return { plaintext, key };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Rollback failure is secondary to the original error.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async revoke(keyId: string, shopId: string, actorId: string): Promise<ApiKeyView> {
    const result = await this.pool.query<ApiKeyRow>(
      `UPDATE api_key
          SET revoked_at = now(), version = version + 1
        WHERE key_id = $1 AND shop_id = $2 AND revoked_at IS NULL
        RETURNING ${VIEW_COLUMNS}`,
      [keyId, shopId],
    );
    const row = result.rows[0];
    if (!row) {
      // Distinguish unknown key from an already-revoked one (idempotent).
      const existing = await this.pool.query<ApiKeyRow>(
        `SELECT ${VIEW_COLUMNS} FROM api_key WHERE key_id = $1 AND shop_id = $2`,
        [keyId, shopId],
      );
      if (!existing.rows[0]) throw new NotFoundException('api key not found');
      return toView(existing.rows[0]);
    }
    const key = toView(row);
    // §12, ADD-20: revocation is audited.
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'api_key.revoke',
      objectType: 'api_key',
      objectId: key.keyId,
      before: { name: key.name, scopes: key.scopes },
    });
    return key;
  }
}
