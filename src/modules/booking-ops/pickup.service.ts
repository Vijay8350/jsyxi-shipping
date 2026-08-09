import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { createHash } from 'crypto';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { AdapterCallerService } from '../courier-framework/adapter-caller.service';
import type { BookingSnapshot } from '../booking/booking.types';
import type { payment_mode } from '../courier-framework/adapter.enum-types';
import { buildSinglePagePdf } from './pdf';
import { DocumentUrlSigner } from './document-urls';
import { OBJECT_STORE, ObjectStore } from './object-store';
import {
  MANIFEST_RETENTION_DAYS,
  ManifestLine,
  PickupScheduleGroupResult,
  PickupScheduleResult,
  PickupScheduleSkipped,
} from './booking-ops.types';

/**
 * §9.5.5 pickup scheduling + manifest (A4-02). Shipments are grouped by
 * courier SERVICE ONLY — one schedulePickup adapter call per group (per
 * courier account within the group) and ONE manifest PDF per service group.
 *
 *  - On the adapter ack, custody moves PICKUP_PENDING → PICKUP_SCHEDULED
 *    (§3.3, guarded UPDATE so a concurrent cancellation race never loses).
 *  - reversePickupScheduled is the §3.3 reverse — PICKUP_SCHEDULED →
 *    PICKUP_PENDING when the courier cancels the pickup — exposed as a plain
 *    service method for the later tracking module (§9.7), audited (§12).
 *  - The manifest reads the frozen snapshot (INV-8), never current master
 *    data. Manifest number per §13.5: MF-{yyyymmdd}-{seq} per shop per day,
 *    allocated under an advisory lock (no sequence table exists in the
 *    schema and booking-ops adds no migration — the count of that day's
 *    manifest documents + 1, serialized by the lock).
 *  - Storage: ObjectStore (S3-compatible seam; local driver today), object
 *    key prefixed shops/{shop_id}/... (INV-1); the document row carries
 *    sha256, bytes, expires_at = now + 90 days (§5.4) and is_test inherited
 *    from its shipments; the document_job row lands in SUCCEEDED.
 */

interface ShipmentPickupRow {
  shipment_id: string;
  order_id: string;
  service_id: string | null;
  courier_account_id: string | null;
  pickup_location_id: string | null;
  awb_normalized: string | null;
  awb_raw: string | null;
  booking_state: string;
  custody_state: string;
  is_test: boolean;
  snapshot: BookingSnapshot | null;
}

/** Shop-local calendar date as yyyymmdd (§5.2, §13.5). */
export function shopLocalYyyymmdd(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

@Injectable()
export class PickupService {
  private readonly logger = new Logger(PickupService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly adapterCaller: AdapterCallerService,
    private readonly signer: DocumentUrlSigner,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async schedulePickups(args: {
    shopId: string;
    shipmentIds: string[];
    actorId: string | null;
  }): Promise<PickupScheduleResult> {
    const { shopId, shipmentIds } = args;
    const skipped: PickupScheduleSkipped[] = [];
    const uniqueIds = [...new Set(shipmentIds)];
    if (uniqueIds.length === 0) return { groups: [], skipped: [] };

    const { rows } = await this.pool.query<ShipmentPickupRow>(
      `SELECT shipment_id, order_id, service_id, courier_account_id,
              pickup_location_id, awb_normalized, awb_raw,
              booking_state, custody_state, is_test, snapshot
         FROM shipment
        WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])`,
      [shopId, uniqueIds],
    );
    const found = new Map(rows.map((r) => [r.shipment_id, r]));

    // Only CONFIRMED + PICKUP_PENDING with an AWB can be scheduled (§3.3);
    // every other input id is reported in INPUT order with its current
    // states, never silently skipped (INV-20).
    const eligible: ShipmentPickupRow[] = [];
    for (const id of uniqueIds) {
      const row = found.get(id);
      if (!row) {
        skipped.push({ shipmentId: id, reason: 'SHIPMENT_NOT_FOUND' });
        continue;
      }
      if (row.booking_state === 'CONFIRMED' && row.custody_state === 'PICKUP_PENDING' && row.awb_normalized) {
        eligible.push(row);
      } else {
        skipped.push({
          shipmentId: row.shipment_id,
          reason: 'NOT_PICKUP_PENDING',
          bookingState: row.booking_state,
          custodyState: row.custody_state,
        });
      }
    }

    // A4-02: group by courier SERVICE only.
    const groups = new Map<string, ShipmentPickupRow[]>();
    for (const row of eligible) {
      const key = row.service_id ?? 'UNASSIGNED';
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    const results: PickupScheduleGroupResult[] = [];
    for (const [serviceId, members] of groups) {
      try {
        results.push(await this.scheduleGroup(shopId, serviceId, members, args.actorId));
      } catch (err) {
        // The adapter call failed (breaker, budget, provider): the group is
        // reported, custody untouched. IDs and error class only (§5.7 c4).
        this.logger.warn(`pickup scheduling failed for service ${serviceId}: ${(err as Error).name}`);
        for (const member of members) {
          skipped.push({
            shipmentId: member.shipment_id,
            reason: 'SCHEDULE_FAILED',
            detail: (err as Error).name,
          });
        }
      }
    }
    return { groups: results, skipped };
  }

  private async scheduleGroup(
    shopId: string,
    serviceId: string,
    members: ShipmentPickupRow[],
    actorId: string | null,
  ): Promise<PickupScheduleGroupResult> {
    // One schedulePickup call per courier account within the service group;
    // the manifest stays ONE per service group (A4-02).
    const byAccount = new Map<string, ShipmentPickupRow[]>();
    for (const member of members) {
      const account = member.courier_account_id ?? '';
      const list = byAccount.get(account) ?? [];
      list.push(member);
      byAccount.set(account, list);
    }
    const pickupDate = new Date().toISOString().slice(0, 10);
    for (const [accountId, accountMembers] of byAccount) {
      const pickupLocationId = accountMembers.find((m) => m.pickup_location_id)?.pickup_location_id ?? '';
      await this.adapterCaller.call(shopId, accountId, 'schedulePickup', (adapter) =>
        adapter.schedulePickup({
          awbs: accountMembers.map((m) => m.awb_raw ?? m.awb_normalized ?? ''),
          pickupLocationId,
          pickupDate,
        }),
      );
    }

    // §3.3: PICKUP_PENDING → PICKUP_SCHEDULED on the ack. The WHERE guard
    // keeps a concurrent cancel/pickup race safe (machine C owns custody).
    const ids = members.map((m) => m.shipment_id);
    await this.pool.query(
      `UPDATE shipment
          SET custody_state = 'PICKUP_SCHEDULED', version = version + 1
        WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])
          AND custody_state = 'PICKUP_PENDING'`,
      [shopId, ids],
    );

    // The manifest (§9.5.5, §9.9.3): from the frozen snapshots (INV-8).
    const { rows: tzRows } = await this.pool.query<{ timezone: string }>(
      `SELECT COALESCE(ss.timezone, s.iana_timezone) AS timezone
         FROM shop s LEFT JOIN store_settings ss ON ss.shop_id = s.shop_id
        WHERE s.shop_id = $1`,
      [shopId],
    );
    const timezone = tzRows[0]?.timezone ?? 'Asia/Kolkata';
    const yyyymmdd = shopLocalYyyymmdd(new Date(), timezone);
    const manifestNumber = await this.allocateManifestNumber(shopId, yyyymmdd);

    const orderNumbers = await this.loadOrderNumbers(
      shopId,
      members.map((m) => m.order_id),
    );
    const lines: ManifestLine[] = members.map((m) => {
      const snapshot = m.snapshot;
      return {
        awb: m.awb_raw ?? m.awb_normalized ?? '',
        orderNumber: orderNumbers.get(m.order_id) ?? m.order_id,
        weightKg:
          snapshot?.formulaInputs?.billableWeightKg ??
          snapshot?.formulaInputs?.deadWeightKg ??
          '0.000',
        paymentMode: (snapshot?.formulaInputs?.paymentMode ?? 'PREPAID') as payment_mode,
        collectible: snapshot?.formulaInputs?.collectible ?? '0.00',
      };
    });
    const pdf = buildSinglePagePdf({
      lines: [
        `Manifest ${manifestNumber}`,
        `Service: ${serviceId}`,
        `Generated: ${new Date().toISOString()}`,
        '',
        'AWB | Order | Weight (kg) | Payment | Collectible (INR)',
        ...lines.map(
          (l) => `${l.awb} | ${l.orderNumber} | ${l.weightKg} | ${l.paymentMode} | ${l.collectible}`,
        ),
      ],
    });

    // INV-1: the object key is shop-scoped.
    const objectKey = `shops/${shopId}/manifests/${yyyymmdd}/${manifestNumber}.pdf`;
    await this.store.put(objectKey, pdf);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    // §5.4: manifests are retained 90 days.
    const expiresAt = new Date(Date.now() + MANIFEST_RETENTION_DAYS * 24 * 3600 * 1000);
    // INV-19: is_test is inherited from the manifest's shipments — a group is
    // test only when every shipment in it is test (mixed groups stay live;
    // test/live visual filtering is §9.23's concern downstream).
    const isTest = members.every((m) => m.is_test);

    const { rows: docRows } = await this.pool.query<{ document_id: string }>(
      `INSERT INTO document
         (shop_id, kind, object_key, sha256, bytes, expires_at, is_test)
       VALUES ($1, 'MANIFEST', $2, $3, $4, $5, $6)
       RETURNING document_id`,
      [shopId, objectKey, sha256, pdf.length, expiresAt.toISOString(), isTest],
    );
    const documentId = docRows[0].document_id;
    await this.pool.query(
      `INSERT INTO document_job
         (shop_id, kind, requested_by, filters, state, progress, result_document_id)
       VALUES ($1, 'MANIFEST', $2, $3, 'SUCCEEDED', $4, $5)`,
      [
        shopId,
        actorId,
        JSON.stringify({ serviceId, manifestNumber }),
        JSON.stringify({ total: members.length, scheduled: members.length }),
        documentId,
      ],
    );

    await this.audit.record({
      shopId,
      actorKind: actorId ? 'MEMBER' : 'SYSTEM',
      actorId,
      action: 'pickup.scheduled', // §12
      objectType: 'document',
      objectId: documentId,
      after: {
        serviceId,
        manifestNumber,
        shipmentCount: members.length,
        documentJobState: 'SUCCEEDED',
      },
    });

    return {
      serviceId,
      manifestNumber,
      documentId,
      downloadUrl: this.signer.signDocumentUrl(documentId),
      awbs: lines.map((l) => l.awb),
      scheduledShipmentIds: ids,
    };
  }

  /**
   * §13.5: MF-{yyyymmdd}-{seq}, unique per shop per day. No sequence table
   * exists and booking-ops adds no migration — the day's manifest-document
   * count + 1, serialized by a transaction-scoped advisory lock on
   * (shop, day). Zero-padded to 4 (the format leaves seq width open).
   */
  private async allocateManifestNumber(shopId: string, yyyymmdd: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `manifest:${shopId}:${yyyymmdd}`,
      ]);
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM document
          WHERE shop_id = $1 AND kind = 'MANIFEST'
            AND object_key LIKE $2`,
        [shopId, `shops/${shopId}/manifests/${yyyymmdd}/%`],
      );
      await client.query('COMMIT');
      const seq = (rows[0]?.n ?? 0) + 1;
      return `MF-${yyyymmdd}-${String(seq).padStart(4, '0')}`;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadOrderNumbers(shopId: string, orderIds: string[]): Promise<Map<string, string>> {
    if (orderIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ order_id: string; shopify_order_number: string | null }>(
      `SELECT order_id, shopify_order_number FROM "order"
        WHERE shop_id = $1 AND order_id = ANY($2::uuid[])`,
      [shopId, orderIds],
    );
    return new Map(
      rows.filter((r) => r.shopify_order_number).map((r) => [r.order_id, r.shopify_order_number as string]),
    );
  }

  /**
   * §3.3 reverse: PICKUP_SCHEDULED → PICKUP_PENDING when the courier cancels
   * the pickup. Plain service method — the later tracking module (§9.7)
   * calls this on a courier pickup-cancellation event. Audited (§12).
   */
  async reversePickupScheduled(args: {
    shopId: string;
    shipmentIds: string[];
    reason?: string;
  }): Promise<{ reversed: number }> {
    const { rowCount } = await this.pool.query(
      `UPDATE shipment
          SET custody_state = 'PICKUP_PENDING', version = version + 1
        WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])
          AND custody_state = 'PICKUP_SCHEDULED'`,
      [args.shopId, args.shipmentIds],
    );
    const reversed = rowCount ?? 0;
    if (reversed > 0) {
      await this.audit.record({
        shopId: args.shopId,
        actorKind: 'SYSTEM',
        action: 'pickup.schedule_reversed', // §12
        objectType: 'shipment',
        objectId: null,
        after: { reversed, shipmentIds: args.shipmentIds },
        reason: args.reason ?? 'courier cancelled the pickup (§3.3)',
      });
    }
    return { reversed };
  }
}
