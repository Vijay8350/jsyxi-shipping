import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { MAX_PINCODES_PER_ZONE, parsePincodeCsv } from './pincode-csv';
import type { SavedZoneRow } from './rules.types';

/**
 * Saved zones (§9.4.2): named pincode sets used by PINCODE IN_SAVED_ZONE
 * conditions. CSV upload is bounded by §5.1 and normalized to 6-digit
 * pincodes; writes are INV-22 version-checked and audited (§12). §5.3: a
 * zone referenced by any rule condition is never hard-deleted.
 */

const PINCODE_RE = /^[0-9]{6}$/;

export interface SavedZoneView {
  savedZoneId: string;
  name: string;
  pincodes: string[];
  version: number;
}

function toView(row: SavedZoneRow): SavedZoneView {
  return {
    savedZoneId: row.saved_zone_id,
    name: row.name,
    pincodes: row.pincodes,
    version: row.version,
  };
}

/** Normalize and validate an explicit pincode list (same rules as the CSV). */
function normalizePincodes(pincodes: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of pincodes) {
    const p = raw.trim();
    if (!PINCODE_RE.test(p)) {
      throw new BadRequestException(`invalid pincode '${raw}' — must be 6 digits`);
    }
    if (seen.has(p)) continue;
    if (seen.size >= MAX_PINCODES_PER_ZONE) {
      throw new BadRequestException(`exceeds the §5.1 bound (${MAX_PINCODES_PER_ZONE} pincodes)`);
    }
    seen.add(p);
    out.push(p);
  }
  return out;
}

@Injectable()
export class SavedZonesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async list(shopId: string): Promise<SavedZoneView[]> {
    const { rows } = await this.pool.query<SavedZoneRow>(
      `SELECT saved_zone_id, shop_id, name, pincodes, version, created_at, updated_at
         FROM saved_zone WHERE shop_id = $1 ORDER BY name`,
      [shopId],
    );
    return rows.map(toView);
  }

  async get(shopId: string, savedZoneId: string): Promise<SavedZoneView> {
    const { rows } = await this.pool.query<SavedZoneRow>(
      `SELECT saved_zone_id, shop_id, name, pincodes, version, created_at, updated_at
         FROM saved_zone WHERE shop_id = $1 AND saved_zone_id = $2`,
      [shopId, savedZoneId],
    );
    if (!rows[0]) throw new NotFoundException('saved zone not found');
    return toView(rows[0]);
  }

  private resolvePincodes(input: { pincodes?: string[]; csv?: string }): {
    pincodes: string[];
    csvErrors: { row: number; value: string; reason: string }[];
  } {
    const explicit = input.pincodes ? normalizePincodes(input.pincodes) : [];
    if (!input.csv) return { pincodes: explicit, csvErrors: [] };
    const parsed = parsePincodeCsv(input.csv);
    const merged = normalizePincodes([...explicit, ...parsed.pincodes]);
    return { pincodes: merged, csvErrors: parsed.errors };
  }

  async create(
    shopId: string,
    memberId: string,
    input: { name: string; pincodes?: string[]; csv?: string },
  ): Promise<SavedZoneView & { csvErrors: { row: number; value: string; reason: string }[] }> {
    const { pincodes, csvErrors } = this.resolvePincodes(input);
    try {
      const { rows } = await this.pool.query<SavedZoneRow>(
        `INSERT INTO saved_zone (shop_id, name, pincodes)
         VALUES ($1, $2, $3)
         RETURNING saved_zone_id, shop_id, name, pincodes, version, created_at, updated_at`,
        [shopId, input.name, pincodes],
      );
      const view = toView(rows[0]);
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: memberId,
        action: 'saved_zone.create',
        objectType: 'saved_zone',
        objectId: view.savedZoneId,
        after: { name: view.name, pincodeCount: view.pincodes.length },
      });
      return { ...view, csvErrors };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException(`a saved zone named '${input.name}' already exists`);
      }
      throw err;
    }
  }

  async update(
    shopId: string,
    memberId: string,
    savedZoneId: string,
    input: { name?: string; pincodes?: string[]; csv?: string; version: number },
  ): Promise<SavedZoneView & { csvErrors: { row: number; value: string; reason: string }[] }> {
    const before = await this.get(shopId, savedZoneId);
    const { pincodes, csvErrors } =
      input.pincodes || input.csv ? this.resolvePincodes(input) : { pincodes: before.pincodes, csvErrors: [] };
    try {
      // INV-22: the write carries the version the writer read.
      const { rowCount } = await this.pool.query(
        `UPDATE saved_zone SET name = $3, pincodes = $4, version = version + 1
          WHERE shop_id = $1 AND saved_zone_id = $2 AND version = $5`,
        [shopId, savedZoneId, input.name ?? before.name, pincodes, input.version],
      );
      if (rowCount !== 1) {
        throw new ConflictException({ code: 'VERSION_CONFLICT', current: before });
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException(`a saved zone named '${input.name}' already exists`);
      }
      throw err;
    }
    const after = await this.get(shopId, savedZoneId);
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'saved_zone.edit',
      objectType: 'saved_zone',
      objectId: savedZoneId,
      before: { name: before.name, pincodeCount: before.pincodes.length },
      after: { name: after.name, pincodeCount: after.pincodes.length },
    });
    return { ...after, csvErrors };
  }

  /** §5.3: hard delete only while unused — a zone referenced by any rule's
   *  IN_SAVED_ZONE condition is never deleted. */
  async remove(shopId: string, memberId: string, savedZoneId: string): Promise<void> {
    const before = await this.get(shopId, savedZoneId);
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM rule_condition rc
         JOIN rule r ON r.rule_id = rc.rule_id
        WHERE r.shop_id = $1
          AND rc.operator = 'IN_SAVED_ZONE'
          AND rc.value_json ->> 'zoneId' = $2`,
      [shopId, savedZoneId],
    );
    if ((rows[0]?.n ?? 0) > 0) {
      throw new ConflictException('saved zone is used by a rule condition (§5.3)');
    }
    const { rowCount } = await this.pool.query(
      `DELETE FROM saved_zone WHERE shop_id = $1 AND saved_zone_id = $2`,
      [shopId, savedZoneId],
    );
    if (rowCount !== 1) throw new NotFoundException('saved zone not found');
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'saved_zone.delete',
      objectType: 'saved_zone',
      objectId: savedZoneId,
      before: { name: before.name, pincodeCount: before.pincodes.length },
    });
  }
}
