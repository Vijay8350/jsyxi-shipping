import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { validateMatcher, ZONE_CODES, type ZoneCode } from './pricing';
import {
  isPgErrorWithMessage,
  type ZoneMapRow,
  type ZoneRuleRow,
} from './rate-engine.types';

export interface ZoneRuleInputDto {
  originMatcher: unknown;
  destinationMatcher: unknown;
  zone: ZoneCode;
  position: number;
}

export interface CreateZoneMapInput {
  serviceId: string;
  label: string;
  effectiveFrom: string;
  /** Immutable frozen postal master reference (A1-05, F-4). */
  postalVersionId: string;
  rules: ZoneRuleInputDto[];
}

export interface ZoneMapDetail {
  zoneMap: ZoneMapRow;
  rules: ZoneRuleRow[];
}

/**
 * Commercial zone map persistence (§2.3, §4.3, §9.15). A map + its rules are
 * created in one transaction; matchers are validated against the documented
 * F-4 matcher shape at write time so resolution never meets garbage. Sealing
 * is the only mutation (INV-11); all queries shop-scoped (INV-1); writes
 * carry the version the writer read (INV-22).
 */
@Injectable()
export class ZoneMapsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private rethrowSealViolation(err: unknown): never {
    if (isPgErrorWithMessage(err, 'INV-11')) {
      throw new ConflictException((err as Error).message);
    }
    throw err;
  }

  private validateRules(rules: ZoneRuleInputDto[]): void {
    const positions = new Set<number>();
    for (const rule of rules) {
      if (!validateMatcher(rule.originMatcher)) {
        throw new BadRequestException(
          `origin_matcher at position ${rule.position} is not a valid F-4 matcher (§4.3): ` +
            'expected an object over pincode/city/district/state/region/is_metro/is_special ' +
            'with exact (string), list (string[]), prefix ({prefix}) or boolean predicates',
        );
      }
      if (!validateMatcher(rule.destinationMatcher)) {
        throw new BadRequestException(
          `destination_matcher at position ${rule.position} is not a valid F-4 matcher (§4.3)`,
        );
      }
      if (!(ZONE_CODES as readonly string[]).includes(rule.zone)) {
        throw new BadRequestException(`zone must be A–E, got "${rule.zone}"`);
      }
      if (positions.has(rule.position)) {
        throw new BadRequestException(`duplicate rule position ${rule.position} — first match wins needs a total order (§4.3)`);
      }
      positions.add(rule.position);
    }
  }

  /** §9.15: create a zone map with its rules in one transaction (Finance+). */
  async createZoneMap(
    shopId: string,
    memberId: string,
    input: CreateZoneMapInput,
  ): Promise<ZoneMapDetail> {
    this.validateRules(input.rules);
    try {
      const detail = await this.withTransaction(async (client) => {
        const { rows: maps } = await client.query<ZoneMapRow>(
          `INSERT INTO commercial_zone_map
             (shop_id, service_id, label, effective_from, postal_version_id)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`,
          [shopId, input.serviceId, input.label, input.effectiveFrom, input.postalVersionId],
        );
        const zoneMap = maps[0];
        const rules: ZoneRuleRow[] = [];
        for (const rule of input.rules) {
          const { rows } = await client.query<ZoneRuleRow>(
            `INSERT INTO commercial_zone_rule
               (zone_map_id, origin_matcher, destination_matcher, zone, position)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING *`,
            [
              zoneMap.zone_map_id,
              JSON.stringify(rule.originMatcher),
              JSON.stringify(rule.destinationMatcher),
              rule.zone,
              rule.position,
            ],
          );
          rules.push(rows[0]);
        }
        return { zoneMap, rules };
      });

      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: memberId,
        action: 'zone_map.create', // §12 (rate card & zone map config)
        objectType: 'commercial_zone_map',
        objectId: detail.zoneMap.zone_map_id,
        after: {
          serviceId: input.serviceId,
          label: input.label,
          effectiveFrom: input.effectiveFrom,
          postalVersionId: input.postalVersionId,
          ruleCount: detail.rules.length,
        },
      });
      return detail;
    } catch (err) {
      this.rethrowSealViolation(err);
    }
  }

  async listZoneMaps(shopId: string, serviceId?: string): Promise<ZoneMapDetail[]> {
    const params: unknown[] = [shopId];
    let filter = '';
    if (serviceId) {
      params.push(serviceId);
      filter = 'AND service_id = $2';
    }
    const { rows: maps } = await this.pool.query<ZoneMapRow>(
      `SELECT * FROM commercial_zone_map
        WHERE shop_id = $1 ${filter}
        ORDER BY created_at ASC`,
      params,
    );
    const details: ZoneMapDetail[] = [];
    for (const zoneMap of maps) {
      const { rows: rules } = await this.pool.query<ZoneRuleRow>(
        `SELECT * FROM commercial_zone_rule
          WHERE zone_map_id = $1
          ORDER BY position ASC`,
        [zoneMap.zone_map_id],
      );
      details.push({ zoneMap, rules });
    }
    return details;
  }

  /**
   * INV-11: seal a zone map. Called by Finance+ here and by the booking
   * module when a snapshot first references the map; the DB triggers enforce
   * immutability of the map and its rules from then on. INV-22 version check.
   */
  async seal(
    shopId: string,
    memberId: string,
    zoneMapId: string,
    expectedVersion: number,
  ): Promise<ZoneMapRow> {
    const { rows } = await this.pool.query<ZoneMapRow>(
      `UPDATE commercial_zone_map
          SET is_sealed = true, version = version + 1
        WHERE zone_map_id = $1
          AND shop_id = $2
          AND version = $3
          AND is_sealed = false
        RETURNING *`,
      [zoneMapId, shopId, expectedVersion],
    );
    if (!rows[0]) {
      const { rows: current } = await this.pool.query<ZoneMapRow>(
        `SELECT * FROM commercial_zone_map WHERE zone_map_id = $1 AND shop_id = $2`,
        [zoneMapId, shopId],
      );
      if (!current[0]) throw new NotFoundException('zone map not found');
      throw new ConflictException({
        message: current[0].is_sealed
          ? 'zone map is already sealed (INV-11)'
          : 'version mismatch (INV-22)',
        current: current[0],
      });
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'zone_map.seal', // §12
      objectType: 'commercial_zone_map',
      objectId: zoneMapId,
      before: { is_sealed: false },
      after: { is_sealed: true },
    });
    return rows[0];
  }
}
