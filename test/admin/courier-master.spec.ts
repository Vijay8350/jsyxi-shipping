import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { CourierMasterService } from '../../src/modules/admin/courier-master.service';
import { TrackingDelayService } from '../../src/modules/tracking/tracking-delay.service';
import { COURIER_ID, auditStrings, makeActor, makeAudit, makePool, poolCalls } from './helpers';

/**
 * §9.13 Courier Master CRUD: credential-schema builder (is_secret, INV-18),
 * services + versions, the §3.6 status-map editor and the guides manager.
 */

function makeService(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool, client } = makePool(queryImpl);
  const audit = makeAudit();
  const tracking = { listUnmappedStatuses: async () => [] };
  const service = new CourierMasterService(
    pool as unknown as Pool,
    audit as unknown as AuditService,
    tracking as unknown as TrackingDelayService,
  );
  return { service, pool, client, audit };
}

describe('CourierMasterService couriers + credential schema (§9.13, INV-18)', () => {
  it('creates a courier and audits the creation', async () => {
    const { service, audit } = makeService((sql) => {
      if (sql.includes('INSERT INTO courier')) return { rows: [{ courier_id: COURIER_ID }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { courierId } = await service.createCourier(makeActor(), {
      code: 'delhivery',
      name: 'Delhivery',
      kind: 'DIRECT',
      authPattern: 'KEY_PASTE',
    });
    expect(courierId).toBe(COURIER_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_courier.created', objectType: 'courier', objectId: COURIER_ID }),
    );
  });

  it('replaces the credential-field schema transactionally, preserving is_secret', async () => {
    const { service, client, audit } = makeService((sql) => {
      if (sql.includes('SELECT 1 FROM courier')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await service.setCredentialFields(makeActor(), COURIER_ID, [
      { key: 'api_token', label: 'API Token', isSecret: true, isRequired: true, displayOrder: 1 },
      { key: 'client_name', label: 'Client Name', isSecret: false, displayOrder: 2 },
    ]);
    const sql = client.query.mock.calls.map((c) => c[0] as string).join('\n');
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('DELETE FROM courier_credential_field');
    expect(sql).toContain('COMMIT');
    const inserts = client.query.mock.calls.filter((c) =>
      (c[0] as string).includes('INSERT INTO courier_credential_field'),
    );
    expect(inserts).toHaveLength(2);
    // is_secret survives to the row (write-only + masked display, §5.7 control 3).
    expect(inserts[0][1]).toContain(true);
    // INV-18: the schema audit carries keys/flags — never credential values.
    const auditPayload = auditStrings(audit);
    expect(auditPayload).toContain('api_token');
    expect(auditPayload).toContain('admin_courier.credential_schema_set');
  });

  it('rejects duplicate field keys', async () => {
    const { service } = makeService();
    await expect(
      service.setCredentialFields(makeActor(), COURIER_ID, [
        { key: 'token', label: 'A' },
        { key: 'token', label: 'B' },
      ]),
    ).rejects.toThrow('duplicate credential field keys');
  });
});

describe('CourierMasterService status map editor (§3.6, A2-06)', () => {
  it('normalizes raw statuses (trim + case-fold) and upserts per courier', async () => {
    const { service, client } = makeService((sql) => {
      if (sql.includes('SELECT 1 FROM courier')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const result = await service.upsertStatusMap(makeActor(), COURIER_ID, {
      entries: [
        { rawStatus: '  Out For Delivery ', carrierEventStatus: 'OUT_FOR_DELIVERY' },
        { rawStatus: 'DLVD', carrierEventStatus: 'DELIVERED' },
      ],
    });
    expect(result.upserted).toBe(2);
    const upserts = client.query.mock.calls.filter((c) =>
      (c[0] as string).includes('INSERT INTO courier_status_map'),
    );
    expect(upserts[0][1]).toEqual([COURIER_ID, 'out for delivery', 'OUT_FOR_DELIVERY']);
    expect(upserts[0][0]).toContain('ON CONFLICT (courier_id, raw_status)');
  });

  it('rejects duplicates after normalization', async () => {
    const { service } = makeService((sql) => {
      if (sql.includes('SELECT 1 FROM courier')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      service.upsertStatusMap(makeActor(), COURIER_ID, {
        entries: [
          { rawStatus: 'DLVD', carrierEventStatus: 'DELIVERED' },
          { rawStatus: ' dlvd ', carrierEventStatus: 'DELIVERED' },
        ],
      }),
    ).rejects.toThrow('duplicate raw statuses after normalization');
  });

  it('delete audits the removed mapping', async () => {
    const { service, audit } = makeService((sql) => {
      if (sql.includes('DELETE FROM courier_status_map')) {
        return { rows: [{ courier_id: COURIER_ID, raw_status: 'dlvd' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await service.deleteStatusMapEntry(makeActor(), 'map-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_courier.status_map_deleted', objectId: 'map-1' }),
    );
  });
});

describe('CourierMasterService guides + versions (§9.13, INV-11)', () => {
  it('inserts a guide when none exists and publishes instantly on request', async () => {
    const { service, pool } = makeService((sql) => {
      if (sql.includes('SELECT 1 FROM courier')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('SELECT guide_id FROM courier_guide')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO courier_guide')) return { rows: [{ guide_id: 'g1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { guideId } = await service.upsertGuide(makeActor(), COURIER_ID, {
      videoUrl: 'https://cdn.example.com/delhivery.mp4',
      docUrl: 'https://docs.example.com/delhivery',
      pdfObjectKey: 'guides/delhivery.pdf',
      publish: true,
    });
    expect(guideId).toBe('g1');
    const insert = poolCalls(pool).find((c) => c.sql.includes('INSERT INTO courier_guide'));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('CASE WHEN $5 THEN now() ELSE NULL END');
    expect(insert!.params[4]).toBe(true);
  });

  it('creates a service version with decimal-string weights, never floats (§4.1)', async () => {
    const { service, pool } = makeService((sql) => {
      if (sql.includes('INSERT INTO service_version')) {
        return { rows: [{ service_version_id: 'sv1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await service.createServiceVersion(makeActor(), 'svc-1', {
      effectiveFrom: '2026-09-01',
      volumetricDivisor: '5000',
      minBillableKg: '0.5',
      billableIncrementKg: '0.25',
    });
    const insert = poolCalls(pool).find((c) => c.sql.includes('INSERT INTO service_version'));
    expect(insert!.params).toContain('0.25');
    expect(typeof insert!.params[4]).toBe('string');
  });

  it('translates the INV-11 seal trigger refusal into a 409', async () => {
    const { service } = makeService((sql) => {
      if (sql.includes('INSERT INTO service_version')) {
        const err = new Error('INV-11: sealed service_version is immutable') as Error & { code?: string };
        err.code = 'P0001';
        throw err;
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(
      service.createServiceVersion(makeActor(), 'svc-1', { effectiveFrom: '2026-09-01' }),
    ).rejects.toThrow('sealed version is immutable (INV-11)');
  });
});
