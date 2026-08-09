import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { validateRateCardCsv } from './rate-card-csv';
import {
  COMPONENT_BASES,
  ZONE_CODES,
  type ComponentRowInput,
  type RtoBasis,
  type SlabInput,
} from './pricing';
import {
  isPgErrorWithMessage,
  type RateCardComponentRow,
  type RateCardRow,
  type RateCardSlabRow,
  type RateCardVersionRow,
} from './rate-engine.types';

export interface CreateRateCardInput {
  serviceId: string;
  courierAccountId: string;
  name: string;
}

export interface CreateRateCardVersionInput {
  effectiveFrom: string;
  effectiveTo: string | null;
  zoneMapId: string;
  fuelPct: string;
  codFlat: string;
  codPct: string;
  rtoBasis: RtoBasis;
  rtoPct: string | null;
  gstPct: string;
  taxableComponents: string[];
  slabs: SlabInput[];
  components: ComponentRowInput[];
  /** INV-22: the rate_card.version the writer read. */
  rateCardVersion: number;
}

export interface RateCardVersionDetail {
  version: RateCardVersionRow;
  slabs: RateCardSlabRow[];
  components: RateCardComponentRow[];
}

const RTO_BASES: readonly RtoBasis[] = ['SAME_AS_FORWARD', 'PERCENT_OF_FORWARD'];

/**
 * Rate card persistence (§9.15, §2.3). All queries are shop-scoped (INV-1);
 * version create writes version + slabs + components in ONE transaction with
 * the §9.15 non-overlapping-interval check; sealing is the only mutation an
 * existing version ever takes (INV-11 — the DB triggers enforce immutability
 * from there on). INV-22: every write carries the version the writer read.
 * INV-23: there is no margin field anywhere in these writes, by design.
 */
@Injectable()
export class RateCardsService {
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

  /** INV-11: the DB seal triggers raise errors starting 'INV-11' — surface a
   *  clean 409, never a 500. */
  private rethrowSealViolation(err: unknown): never {
    if (isPgErrorWithMessage(err, 'INV-11')) {
      throw new ConflictException((err as Error).message);
    }
    throw err;
  }

  async findCard(shopId: string, rateCardId: string): Promise<RateCardRow | null> {
    const { rows } = await this.pool.query<RateCardRow>(
      `SELECT rate_card_id, shop_id, service_id, courier_account_id, name,
              version, created_at, updated_at
         FROM rate_card
        WHERE shop_id = $1 AND rate_card_id = $2`,
      [shopId, rateCardId],
    );
    return rows[0] ?? null;
  }

  async listCards(shopId: string, serviceId?: string): Promise<RateCardRow[]> {
    const params: unknown[] = [shopId];
    let filter = '';
    if (serviceId) {
      params.push(serviceId);
      filter = 'AND service_id = $2';
    }
    const { rows } = await this.pool.query<RateCardRow>(
      `SELECT rate_card_id, shop_id, service_id, courier_account_id, name,
              version, created_at, updated_at
         FROM rate_card
        WHERE shop_id = $1 ${filter}
        ORDER BY created_at ASC`,
      params,
    );
    return rows;
  }

  /** §9.15: create a rate card for a service on a courier account (Finance+). */
  async createRateCard(
    shopId: string,
    memberId: string,
    input: CreateRateCardInput,
  ): Promise<RateCardRow> {
    const { rows } = await this.pool.query<RateCardRow>(
      `INSERT INTO rate_card (shop_id, service_id, courier_account_id, name)
       VALUES ($1, $2, $3, $4)
       RETURNING rate_card_id, shop_id, service_id, courier_account_id, name,
                 version, created_at, updated_at`,
      [shopId, input.serviceId, input.courierAccountId, input.name],
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'rate_card.create', // §12
      objectType: 'rate_card',
      objectId: rows[0].rate_card_id,
      after: { serviceId: input.serviceId, courierAccountId: input.courierAccountId, name: input.name },
    });
    return rows[0];
  }

  private validateVersionInput(input: CreateRateCardVersionInput): void {
    if (!RTO_BASES.includes(input.rtoBasis)) {
      throw new BadRequestException(`rtoBasis must be one of ${RTO_BASES.join('|')}`);
    }
    if (input.rtoBasis === 'PERCENT_OF_FORWARD' && input.rtoPct === null) {
      throw new BadRequestException('rtoPct is required when rtoBasis is PERCENT_OF_FORWARD (§4.4 F-12)');
    }
    for (const name of input.taxableComponents) {
      if (!['F-5', 'F-6', 'F-7', 'F-8'].includes(name)) {
        throw new BadRequestException(`taxableComponents entries must be F-5…F-8, got "${name}" (§4.4)`);
      }
    }
    const zones = new Set<string>();
    for (const slab of input.slabs) {
      if (!(ZONE_CODES as readonly string[]).includes(slab.zone)) {
        throw new BadRequestException(`slab zone must be A–E, got "${slab.zone}"`);
      }
      if (zones.has(slab.zone)) {
        throw new BadRequestException(`duplicate slab for zone ${slab.zone} — one slab per zone per version (§2.3)`);
      }
      zones.add(slab.zone);
    }
    const positions = new Set<number>();
    for (const component of input.components) {
      if (!(COMPONENT_BASES as readonly string[]).includes(component.basis)) {
        throw new BadRequestException(`component basis "${component.basis}" is not a §3.31/ADD-41 basis`);
      }
      if (positions.has(component.position)) {
        throw new BadRequestException(`duplicate component position ${component.position} (§2.3)`);
      }
      positions.add(component.position);
    }
  }

  /**
   * §9.15: create a version with its slabs and components in one transaction.
   * Effective intervals are non-overlapping per rate card — enforced here
   * with a date-range overlap check inside the transaction. INV-22: the write
   * carries the rate_card.version the writer read.
   */
  async createVersion(
    shopId: string,
    memberId: string,
    rateCardId: string,
    input: CreateRateCardVersionInput,
  ): Promise<RateCardVersionDetail> {
    this.validateVersionInput(input);
    try {
      const detail = await this.withTransaction(async (client) => {
        const { rows: cards } = await client.query<RateCardRow>(
          `SELECT rate_card_id, version FROM rate_card
            WHERE shop_id = $1 AND rate_card_id = $2
            FOR UPDATE`,
          [shopId, rateCardId],
        );
        const card = cards[0];
        if (!card) throw new NotFoundException('rate card not found');
        // INV-22 optimistic concurrency.
        if (card.version !== input.rateCardVersion) {
          throw new ConflictException({
            message: 'version mismatch (INV-22)',
            current: { rateCardId, version: card.version },
          });
        }
        // §9.15: effective intervals are non-overlapping per rate card.
        const { rows: overlaps } = await client.query(
          `SELECT rate_card_version_id, effective_from, effective_to
             FROM rate_card_version
            WHERE rate_card_id = $1
              AND effective_from <= COALESCE($3::date, 'infinity'::date)
              AND (effective_to IS NULL OR effective_to >= $2::date)
            LIMIT 1`,
          [rateCardId, input.effectiveFrom, input.effectiveTo],
        );
        if (overlaps[0]) {
          throw new ConflictException({
            message: 'effective interval overlaps an existing version (§9.15)',
            overlapping: overlaps[0],
          });
        }

        const { rows: versions } = await client.query<RateCardVersionRow>(
          `INSERT INTO rate_card_version
             (rate_card_id, effective_from, effective_to, zone_map_id,
              fuel_pct, cod_flat, cod_pct, rto_basis, rto_pct, gst_pct,
              taxable_components)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *`,
          [
            rateCardId,
            input.effectiveFrom,
            input.effectiveTo,
            input.zoneMapId,
            input.fuelPct,
            input.codFlat,
            input.codPct,
            input.rtoBasis,
            input.rtoPct,
            input.gstPct,
            input.taxableComponents,
          ],
        );
        const version = versions[0];

        const slabs: RateCardSlabRow[] = [];
        for (const slab of input.slabs) {
          const { rows } = await client.query<RateCardSlabRow>(
            `INSERT INTO rate_card_slab
               (rate_card_version_id, zone, base_weight_kg, base_rate,
                additional_step_kg, additional_rate)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING *`,
            [
              version.rate_card_version_id,
              slab.zone,
              slab.baseWeightKg,
              slab.baseRate,
              slab.additionalStepKg,
              slab.additionalRate,
            ],
          );
          slabs.push(rows[0]);
        }

        const components: RateCardComponentRow[] = [];
        for (const component of input.components) {
          const { rows } = await client.query<RateCardComponentRow>(
            `INSERT INTO rate_card_component
               (rate_card_version_id, code, label, basis, value, is_taxable, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING *`,
            [
              version.rate_card_version_id,
              component.code,
              component.label,
              component.basis,
              component.value,
              component.isTaxable,
              component.position,
            ],
          );
          components.push(rows[0]);
        }

        // INV-22: the card's version moves with every child write.
        await client.query(
          `UPDATE rate_card SET version = version + 1
            WHERE rate_card_id = $1`,
          [rateCardId],
        );
        return { version, slabs, components };
      });

      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: memberId,
        action: 'rate_card_version.create', // §12
        objectType: 'rate_card_version',
        objectId: detail.version.rate_card_version_id,
        after: {
          rateCardId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          zoneMapId: input.zoneMapId,
          slabCount: detail.slabs.length,
          componentCount: detail.components.length,
        },
      });
      return detail;
    } catch (err) {
      this.rethrowSealViolation(err);
    }
  }

  async listVersions(shopId: string, rateCardId: string): Promise<RateCardVersionDetail[]> {
    const card = await this.findCard(shopId, rateCardId);
    if (!card) throw new NotFoundException('rate card not found');
    const { rows: versions } = await this.pool.query<RateCardVersionRow>(
      `SELECT * FROM rate_card_version
        WHERE rate_card_id = $1
        ORDER BY effective_from ASC`,
      [rateCardId],
    );
    const details: RateCardVersionDetail[] = [];
    for (const version of versions) {
      const { rows: slabs } = await this.pool.query<RateCardSlabRow>(
        `SELECT * FROM rate_card_slab WHERE rate_card_version_id = $1 ORDER BY zone`,
        [version.rate_card_version_id],
      );
      const { rows: components } = await this.pool.query<RateCardComponentRow>(
        `SELECT * FROM rate_card_component WHERE rate_card_version_id = $1 ORDER BY position`,
        [version.rate_card_version_id],
      );
      details.push({ version, slabs, components });
    }
    return details;
  }

  /**
   * INV-11: seal a version (the booking module also calls this when a snapshot
   * first references the version). The only permitted UPDATE on the row; after
   * it the DB triggers reject every further write to the version and its
   * children. INV-22: carries the version the writer read.
   */
  async seal(
    shopId: string,
    memberId: string,
    rateCardVersionId: string,
    expectedVersion: number,
  ): Promise<RateCardVersionRow> {
    const { rows } = await this.pool.query<RateCardVersionRow>(
      `UPDATE rate_card_version v
          SET is_sealed = true, version = v.version + 1
         FROM rate_card c
        WHERE v.rate_card_version_id = $1
          AND v.rate_card_id = c.rate_card_id
          AND c.shop_id = $2
          AND v.version = $3
          AND v.is_sealed = false
        RETURNING v.*`,
      [rateCardVersionId, shopId, expectedVersion],
    );
    if (!rows[0]) {
      const { rows: current } = await this.pool.query<RateCardVersionRow>(
        `SELECT v.* FROM rate_card_version v
           JOIN rate_card c ON c.rate_card_id = v.rate_card_id
          WHERE v.rate_card_version_id = $1 AND c.shop_id = $2`,
        [rateCardVersionId, shopId],
      );
      if (!current[0]) throw new NotFoundException('rate card version not found');
      throw new ConflictException({
        message: current[0].is_sealed
          ? 'rate card version is already sealed (INV-11)'
          : 'version mismatch (INV-22)',
        current: current[0],
      });
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'rate_card_version.seal', // §12
      objectType: 'rate_card_version',
      objectId: rateCardVersionId,
      before: { is_sealed: false },
      after: { is_sealed: true },
    });
    return rows[0];
  }

  /**
   * §9.15 CSV two-step, confirm half: re-validate the uploaded text and, only
   * when every row is clean, persist it as a new version (one transaction,
   * same overlap + INV-22 rules as createVersion). A failed validation is a
   * 422 carrying the preview — nothing partial is ever written (INV-20).
   */
  async confirmCsvUpload(
    shopId: string,
    memberId: string,
    rateCardId: string,
    versionInput: Omit<CreateRateCardVersionInput, 'slabs' | 'components'>,
    csvText: string,
  ): Promise<RateCardVersionDetail> {
    const preview = validateRateCardCsv(csvText);
    if (!preview.ok) {
      throw new UnprocessableEntityException({
        message: 'CSV validation failed — nothing was saved (§9.15)',
        preview,
      });
    }
    return this.createVersion(shopId, memberId, rateCardId, {
      ...versionInput,
      slabs: preview.slabs,
      components: preview.components,
    });
  }
}
