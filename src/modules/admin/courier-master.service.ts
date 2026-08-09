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
import {
  TrackingDelayService,
  UnmappedStatusRow,
} from '../tracking/tracking-delay.service';
import {
  CreateCourierDto,
  CreateServiceDto,
  CreateServiceVersionDto,
  CredentialFieldDto,
  SetStatusMapDto,
  UpdateCourierDto,
  UpdateServiceDto,
  UpsertCourierGuideDto,
} from './courier-master.dto';
import { AdminContext } from './admin.types';

/**
 * §9.13 Courier Master CRUD: couriers, the credential-schema builder
 * (is_secret honoured — INV-18 / §5.7 control 3), services + service versions,
 * the courier_status_map editor (§3.6, A2-06) and the per-courier guides
 * manager (video + doc + PDF, live instantly — plain DB writes).
 *
 * All tables here are [global] platform reference data (migration 0006), so
 * these queries are platform-wide BY DESIGN; every mutation is audited (§12)
 * with before/after and no secrets (INV-18). INV-11 sealing of
 * service_version is enforced by the DB trigger; this service surfaces the
 * trigger's refusal as 409 rather than bypassing it.
 */
@Injectable()
export class CourierMasterService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly trackingDelay: TrackingDelayService,
  ) {}

  // ------------------------------------------------------------------
  // Couriers
  // ------------------------------------------------------------------

  async listCouriers(): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT courier_id, code, name, kind, auth_pattern, is_active, version, created_at
         FROM courier
        ORDER BY code ASC`,
    );
    return rows;
  }

  async courierDetail(courierId: string): Promise<unknown> {
    const courier = await this.pool.query(
      `SELECT courier_id, code, name, kind, auth_pattern, is_active, version, created_at
         FROM courier WHERE courier_id = $1`,
      [courierId],
    );
    if (courier.rows.length === 0) throw new NotFoundException('courier not found');
    const [fields, services, statusMap, guides] = await Promise.all([
      this.pool.query(
        `SELECT field_id, key, label, type, is_secret, is_required, validation_regex, display_order
           FROM courier_credential_field WHERE courier_id = $1 ORDER BY display_order, key`,
        [courierId],
      ),
      this.pool.query(
        `SELECT service_id, code, name, label_mode, cost_source, is_active, version
           FROM service WHERE courier_id = $1 ORDER BY code`,
        [courierId],
      ),
      this.pool.query(
        `SELECT map_id, raw_status, carrier_event_status
           FROM courier_status_map WHERE courier_id = $1 ORDER BY raw_status`,
        [courierId],
      ),
      this.pool.query(
        `SELECT guide_id, video_url, doc_url, pdf_object_key, published_at
           FROM courier_guide WHERE courier_id = $1`,
        [courierId],
      ),
    ]);
    return {
      ...courier.rows[0],
      credential_fields: fields.rows,
      services: services.rows,
      status_map: statusMap.rows,
      guides: guides.rows,
    };
  }

  async createCourier(actor: AdminContext, dto: CreateCourierDto): Promise<{ courierId: string }> {
    try {
      const { rows } = await this.pool.query<{ courier_id: string }>(
        `INSERT INTO courier (code, name, kind, auth_pattern)
         VALUES ($1, $2, $3, $4)
         RETURNING courier_id`,
        [dto.code, dto.name, dto.kind, dto.authPattern],
      );
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: actor.adminId,
        action: 'admin_courier.created',
        objectType: 'courier',
        objectId: rows[0].courier_id,
        after: { code: dto.code, name: dto.name, kind: dto.kind, auth_pattern: dto.authPattern },
      });
      return { courierId: rows[0].courier_id };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('courier code already exists');
      throw err;
    }
  }

  async updateCourier(actor: AdminContext, courierId: string, dto: UpdateCourierDto): Promise<void> {
    const before = await this.pool.query(
      `SELECT name, is_active FROM courier WHERE courier_id = $1`,
      [courierId],
    );
    if (before.rows.length === 0) throw new NotFoundException('courier not found');
    await this.pool.query(
      `UPDATE courier
          SET name = COALESCE($2, name),
              is_active = COALESCE($3, is_active),
              version = version + 1
        WHERE courier_id = $1`,
      [courierId, dto.name ?? null, dto.isActive ?? null],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_courier.updated',
      objectType: 'courier',
      objectId: courierId,
      before: before.rows[0],
      after: { name: dto.name, is_active: dto.isActive },
    });
  }

  // ------------------------------------------------------------------
  // Credential-schema builder (A1-12; is_secret → write-only, INV-18)
  // ------------------------------------------------------------------

  /**
   * Replace the courier's credential-field schema with the given list.
   * is_secret marks a field write-only with masked display on the merchant
   * form (§5.7 control 3); the schema row itself never holds a value.
   */
  async setCredentialFields(
    actor: AdminContext,
    courierId: string,
    fields: CredentialFieldDto[],
  ): Promise<void> {
    const keys = fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException('duplicate credential field keys');
    }
    const exists = await this.pool.query(
      `SELECT 1 FROM courier WHERE courier_id = $1`,
      [courierId],
    );
    if (exists.rows.length === 0) throw new NotFoundException('courier not found');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query(
        `SELECT key, label, type, is_secret, is_required, validation_regex, display_order
           FROM courier_credential_field WHERE courier_id = $1 ORDER BY key`,
        [courierId],
      );
      await client.query(`DELETE FROM courier_credential_field WHERE courier_id = $1`, [courierId]);
      for (const f of fields) {
        await client.query(
          `INSERT INTO courier_credential_field
             (courier_id, key, label, type, is_secret, is_required, validation_regex, display_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            courierId,
            f.key,
            f.label,
            f.type ?? 'text',
            f.isSecret ?? false,
            f.isRequired ?? true,
            f.validationRegex ?? null,
            f.displayOrder ?? 0,
          ],
        );
      }
      await client.query('COMMIT');
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: actor.adminId,
        action: 'admin_courier.credential_schema_set',
        objectType: 'courier',
        objectId: courierId,
        before: { fields: before.rows },
        // Keys and flags only — the schema never carries credential VALUES (INV-18).
        after: {
          fields: fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type ?? 'text',
            is_secret: f.isSecret ?? false,
            is_required: f.isRequired ?? true,
            display_order: f.displayOrder ?? 0,
          })),
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // Services + service versions (§9.3.2; INV-11 sealing is DB-enforced)
  // ------------------------------------------------------------------

  async createService(
    actor: AdminContext,
    courierId: string,
    dto: CreateServiceDto,
  ): Promise<{ serviceId: string }> {
    try {
      const { rows } = await this.pool.query<{ service_id: string }>(
        `INSERT INTO service (courier_id, code, name, label_mode, cost_source)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING service_id`,
        [courierId, dto.code, dto.name, dto.labelMode, dto.costSource],
      );
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: actor.adminId,
        action: 'admin_service.created',
        objectType: 'service',
        objectId: rows[0].service_id,
        after: { courier_id: courierId, code: dto.code, name: dto.name },
      });
      return { serviceId: rows[0].service_id };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('service code already exists for this courier');
      if (isFkViolation(err)) throw new NotFoundException('courier not found');
      throw err;
    }
  }

  async updateService(
    actor: AdminContext,
    serviceId: string,
    dto: UpdateServiceDto,
  ): Promise<void> {
    const before = await this.pool.query(
      `SELECT name, is_active FROM service WHERE service_id = $1`,
      [serviceId],
    );
    if (before.rows.length === 0) throw new NotFoundException('service not found');
    await this.pool.query(
      `UPDATE service
          SET name = COALESCE($2, name),
              is_active = COALESCE($3, is_active),
              version = version + 1
        WHERE service_id = $1`,
      [serviceId, dto.name ?? null, dto.isActive ?? null],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_service.updated',
      objectType: 'service',
      objectId: serviceId,
      before: before.rows[0],
      after: { name: dto.name, is_active: dto.isActive },
    });
  }

  async listServiceVersions(serviceId: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT service_version_id, service_id, effective_from, volumetric_divisor,
              min_billable_kg, billable_increment_kg, supports_cod, supports_reverse,
              is_sealed, created_at
         FROM service_version WHERE service_id = $1 ORDER BY effective_from DESC`,
      [serviceId],
    );
    return rows;
  }

  /**
   * New effective-from version (§9.15 versioning stance). Once a booking
   * snapshot references a version the INV-11 trigger seals it; the trigger's
   * exception is translated to 409 here.
   */
  async createServiceVersion(
    actor: AdminContext,
    serviceId: string,
    dto: CreateServiceVersionDto,
  ): Promise<{ serviceVersionId: string }> {
    try {
      const { rows } = await this.pool.query<{ service_version_id: string }>(
        `INSERT INTO service_version
           (service_id, effective_from, volumetric_divisor, min_billable_kg,
            billable_increment_kg, supports_cod, supports_reverse)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6, $7)
         RETURNING service_version_id`,
        [
          serviceId,
          dto.effectiveFrom,
          dto.volumetricDivisor ?? null,
          dto.minBillableKg ?? '0.5',
          dto.billableIncrementKg ?? '0.5',
          dto.supportsCod ?? true,
          dto.supportsReverse ?? false,
        ],
      );
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: actor.adminId,
        action: 'admin_service_version.created',
        objectType: 'service_version',
        objectId: rows[0].service_version_id,
        after: { service_id: serviceId, effective_from: dto.effectiveFrom },
      });
      return { serviceVersionId: rows[0].service_version_id };
    } catch (err) {
      if (isFkViolation(err)) throw new NotFoundException('service not found');
      if (isSealViolation(err)) throw new ConflictException('sealed version is immutable (INV-11)');
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // courier_status_map editor (§3.6 — the only mapping target, A2-06)
  // ------------------------------------------------------------------

  async listStatusMap(courierId: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT map_id, raw_status, carrier_event_status
         FROM courier_status_map WHERE courier_id = $1 ORDER BY raw_status`,
      [courierId],
    );
    return rows;
  }

  /**
   * Bulk-upsert raw → CARRIER_EVENT_STATUS mappings. raw_status is normalized
   * (trimmed, case-folded) before write, matching migration 0006's contract.
   */
  async upsertStatusMap(
    actor: AdminContext,
    courierId: string,
    dto: SetStatusMapDto,
  ): Promise<{ upserted: number }> {
    const exists = await this.pool.query(`SELECT 1 FROM courier WHERE courier_id = $1`, [courierId]);
    if (exists.rows.length === 0) throw new NotFoundException('courier not found');

    const normalized = dto.entries.map((e) => ({
      rawStatus: e.rawStatus.trim().toLowerCase(),
      carrierEventStatus: e.carrierEventStatus,
    }));
    const keys = normalized.map((e) => e.rawStatus);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException('duplicate raw statuses after normalization');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const e of normalized) {
        await client.query(
          `INSERT INTO courier_status_map (courier_id, raw_status, carrier_event_status)
           VALUES ($1, $2, $3)
           ON CONFLICT (courier_id, raw_status)
           DO UPDATE SET carrier_event_status = EXCLUDED.carrier_event_status`,
          [courierId, e.rawStatus, e.carrierEventStatus],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_courier.status_map_upserted',
      objectType: 'courier',
      objectId: courierId,
      after: { entries: normalized },
    });
    return { upserted: normalized.length };
  }

  async deleteStatusMapEntry(actor: AdminContext, mapId: string): Promise<void> {
    const { rows, rowCount } = await this.pool.query<{ courier_id: string; raw_status: string }>(
      `DELETE FROM courier_status_map WHERE map_id = $1 RETURNING courier_id, raw_status`,
      [mapId],
    );
    if (!rowCount) throw new NotFoundException('status map entry not found');
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_courier.status_map_deleted',
      objectType: 'courier_status_map',
      objectId: mapId,
      before: rows[0],
    });
  }

  /**
   * §3.6 / §9.13: the unmapped-status feed that tells the admin WHICH raw
   * statuses still need a map row. Delegates to the tracking module's read
   * model — platform-wide by design (admin surface).
   */
  async listUnmappedStatuses(courierId?: string): Promise<UnmappedStatusRow[]> {
    return this.trackingDelay.listUnmappedStatuses(courierId);
  }

  // ------------------------------------------------------------------
  // courier_guide manager (§9.13: video + doc + PDF, live instantly)
  // ------------------------------------------------------------------

  async upsertGuide(
    actor: AdminContext,
    courierId: string,
    dto: UpsertCourierGuideDto,
  ): Promise<{ guideId: string }> {
    const exists = await this.pool.query(`SELECT 1 FROM courier WHERE courier_id = $1`, [courierId]);
    if (exists.rows.length === 0) throw new NotFoundException('courier not found');

    // One guide row per courier at v1: update in place when present.
    const current = await this.pool.query<{ guide_id: string }>(
      `SELECT guide_id FROM courier_guide WHERE courier_id = $1`,
      [courierId],
    );
    let guideId: string;
    if (current.rows.length > 0) {
      guideId = current.rows[0].guide_id;
      await this.pool.query(
        `UPDATE courier_guide
            SET video_url = COALESCE($2, video_url),
                doc_url = COALESCE($3, doc_url),
                pdf_object_key = COALESCE($4, pdf_object_key),
                published_at = CASE WHEN $5 THEN now() ELSE published_at END
          WHERE guide_id = $1`,
        [guideId, dto.videoUrl ?? null, dto.docUrl ?? null, dto.pdfObjectKey ?? null, dto.publish ?? false],
      );
    } else {
      const { rows } = await this.pool.query<{ guide_id: string }>(
        `INSERT INTO courier_guide (courier_id, video_url, doc_url, pdf_object_key, published_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END)
         RETURNING guide_id`,
        [courierId, dto.videoUrl ?? null, dto.docUrl ?? null, dto.pdfObjectKey ?? null, dto.publish ?? false],
      );
      guideId = rows[0].guide_id;
    }
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_courier.guide_upserted',
      objectType: 'courier_guide',
      objectId: guideId,
      after: {
        courier_id: courierId,
        video_url: dto.videoUrl,
        doc_url: dto.docUrl,
        pdf_object_key: dto.pdfObjectKey,
        published: dto.publish ?? false,
      },
    });
    return { guideId };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function isFkViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503';
}

function isSealViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: string }).message === 'string' &&
    (err as { message: string }).message.includes('INV-11')
  );
}
