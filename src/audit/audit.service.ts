import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

/**
 * Audit writer (§12). Append-only at the database level (migration 0002);
 * this service is the only writer. It records who did what to which object
 * with before/after values — never payload dumps and never secrets (INV-18).
 * Anything security-relevant that happens without an HTTP actor (webhooks,
 * sweeps, jobs) uses actorKind SYSTEM.
 */

export type AuditActorKind = 'MEMBER' | 'ADMIN' | 'SYSTEM';

export interface AuditEntry {
  shopId?: string | null;
  actorKind: AuditActorKind;
  actorId?: string | null;
  action: string;
  objectType?: string | null;
  objectId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ipHash?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log
         (shop_id, actor_kind, actor_id, action, object_type, object_id,
          before, after, reason, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.shopId ?? null,
        entry.actorKind,
        entry.actorId ?? null,
        entry.action,
        entry.objectType ?? null,
        entry.objectId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.reason ?? null,
        entry.ipHash ?? null,
      ],
    );
  }
}
