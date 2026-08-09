import { describe, expect, it } from 'vitest';
import { RetentionService } from '../../src/modules/maintenance/retention.service';
import {
  daysCutoff,
  financialRetentionCutoff,
  monthsCutoff,
  RETENTION_BATCH_SIZE,
} from '../../src/modules/maintenance/retention-horizons';
import { asPool, EMPTY, FakePool, mockAudit, mockErase, NOW, SHOP } from './helpers';

function makeService(pool: FakePool) {
  const erase = mockErase();
  const audit = mockAudit();
  const service = new RetentionService(
    asPool(pool),
    erase as never,
    audit as never,
  );
  return { service, erase, audit };
}

/** Cycles through the given results for matching calls, then falls back. */
function sequence(results: Array<{ rows?: unknown[]; rowCount?: number }>) {
  let i = 0;
  return () => {
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  };
}

describe('RetentionService.sweep (§5.4)', () => {
  it('deletes terminal webhook_inbox rows older than 30 days in bounded batches, one §12 audit row per batch', async () => {
    const next = sequence([
      { rowCount: 5000 },
      { rowCount: 5000 },
      { rowCount: 3200 },
      { rowCount: 0 },
    ]);
    const pool = new FakePool((sql) =>
      /DELETE FROM webhook_inbox/.test(sql) ? next() : EMPTY(sql, []),
    );
    const { service, audit } = makeService(pool);
    const summary = await service.sweep(NOW);

    expect(summary.webhook_inbox).toBe(13200);
    const deletes = pool.matching(/DELETE FROM webhook_inbox/);
    expect(deletes).toHaveLength(4); // looped until a batch deleted nothing
    for (const call of deletes) {
      // bounded: every statement carries the batch-size LIMIT parameter
      expect(call.params[1]).toBe(RETENTION_BATCH_SIZE);
      // 30-day raw-payload horizon, terminal states only (§5.4)
      expect((call.params[0] as Date).toISOString()).toBe(
        daysCutoff(NOW, 30).toISOString(),
      );
      expect(call.sql).toContain("state IN ('PROCESSED', 'DEAD')");
    }
    const audits = audit.entries.filter(
      (e) => (e as { objectType?: string }).objectType === 'webhook_inbox',
    ) as Array<{ actorKind: string; action: string; after: { deleted: number } }>;
    expect(audits.map((a) => a.after.deleted)).toEqual([5000, 5000, 3200]);
    for (const a of audits) {
      expect(a.actorKind).toBe('SYSTEM'); // §12 sweep actor
      expect(a.action).toBe('maintenance.retention_sweep');
    }
  });

  it('drops fully-expired monthly partitions and row-deletes only the default partition', async () => {
    const pool = new FakePool((sql, params) => {
      if (/FROM pg_inherits/.test(sql)) {
        const names =
          params[0] === 'tracking_event_raw'
            ? [
                'tracking_event_raw_2026_06', // fully older than 30d cutoff → drop
                'tracking_event_raw_2026_07', // straddles the cutoff → keep
                'tracking_event_raw_default',
              ]
            : [
                'tracking_event_2024_07', // fully older than 24mo cutoff → drop
                'tracking_event_2024_08', // straddles → keep
                'tracking_event_default',
              ];
        return { rows: names.map((name) => ({ name })) };
      }
      return EMPTY(sql, params);
    });
    const { service, audit } = makeService(pool);
    const summary = await service.sweep(NOW);

    expect(summary.tracking_event_raw_partitions_dropped).toBe(1);
    expect(summary.tracking_event_partitions_dropped).toBe(1);
    expect(
      pool.matching(/ALTER TABLE tracking_event_raw DETACH PARTITION tracking_event_raw_2026_06/),
    ).toHaveLength(1);
    expect(pool.matching(/DROP TABLE tracking_event_raw_2026_06/)).toHaveLength(1);
    expect(
      pool.matching(/ALTER TABLE tracking_event DETACH PARTITION tracking_event_2024_07/),
    ).toHaveLength(1);
    // kept partitions are never touched
    expect(pool.matching(/DETACH PARTITION tracking_event_raw_2026_07/)).toHaveLength(0);
    expect(pool.matching(/DETACH PARTITION tracking_event_2024_08/)).toHaveLength(0);
    // the default partition falls back to bounded row deletes (§5.4)
    const rawDefault = pool.matching(/DELETE FROM tracking_event_raw_default/);
    expect(rawDefault).toHaveLength(1);
    expect((rawDefault[0].params[0] as Date).toISOString()).toBe(
      daysCutoff(NOW, 30).toISOString(),
    );
    const eventDefault = pool.matching(/DELETE FROM tracking_event_default/);
    expect((eventDefault[0].params[0] as Date).toISOString()).toBe(
      monthsCutoff(NOW, 24).toISOString(),
    );
    // each dropped partition is one §12 audit row
    const drops = audit.entries.filter(
      (e) => (e as { after?: { dropped?: boolean } }).after?.dropped === true,
    );
    expect(drops).toHaveLength(2);
  });

  it('erases object bytes then deletes document rows past expires_at (90-day labels/manifests)', async () => {
    const next = sequence([
      {
        rows: [
          {
            document_id: 'd1',
            shop_id: SHOP,
            object_key: `shops/${SHOP}/labels/l.pdf`,
          },
        ],
      },
      { rows: [] },
    ]);
    const pool = new FakePool((sql, params) => {
      if (/FROM document/.test(sql) && /expires_at/.test(sql)) return next();
      if (/DELETE FROM document/.test(sql)) return { rowCount: 1 };
      return EMPTY(sql, params);
    });
    const { service, erase, audit } = makeService(pool);
    const summary = await service.sweep(NOW);

    expect(summary.document).toBe(1);
    expect(erase.deleted).toEqual([`shops/${SHOP}/labels/l.pdf`]);
    // §5.3: references block deletion — job references detached first
    expect(pool.matching(/UPDATE document_job SET result_document_id = NULL/)).toHaveLength(1);
    expect(pool.matching(/UPDATE report_job SET result_document_id = NULL/)).toHaveLength(1);
    expect(pool.matching(/DELETE FROM document/)).toHaveLength(1);
    const docAudit = audit.entries.find(
      (e) => (e as { objectType?: string }).objectType === 'document',
    ) as { after: { deleted: number; objects_erased: number } };
    expect(docAudit.after).toMatchObject({ deleted: 1, objects_erased: 1 });
  });

  it('applies the 7-FY cutoff only to INVOICE documents', async () => {
    const pool = new FakePool(EMPTY);
    const { service } = makeService(pool);
    await service.sweep(NOW);

    const invoiceSelects = pool.matching(/kind = 'INVOICE' AND generated_at/);
    expect(invoiceSelects).toHaveLength(1);
    expect((invoiceSelects[0].params[0] as Date).toISOString()).toBe(
      financialRetentionCutoff(NOW).toISOString(), // FY2026 → 2020-04-01
    );
    // the expiry path explicitly excludes invoices (7-FY horizon wins)
    const expirySelects = pool.matching(/expires_at IS NOT NULL/);
    expect(expirySelects[0].sql).toContain("kind <> 'INVOICE'");
  });

  it('erases report export objects older than 30 days but keeps the report_job row (§5.4)', async () => {
    const next = sequence([
      { rows: [{ report_job_id: 'j1', shop_id: SHOP }] },
      { rows: [] },
    ]);
    const pool = new FakePool((sql, params) => {
      if (/FROM report_job/.test(sql) && /state = 'SUCCEEDED'/.test(sql)) {
        return next();
      }
      return EMPTY(sql, params);
    });
    const { service, erase, audit } = makeService(pool);
    const summary = await service.sweep(NOW);

    expect(summary.report_export_objects).toBe(1);
    expect(erase.deleted).toEqual([`shops/${SHOP}/reports/j1.csv`]);
    expect(pool.matching(/DELETE FROM report_job/)).toHaveLength(0);
    const jobAudit = audit.entries.find(
      (e) => (e as { objectType?: string }).objectType === 'report_job',
    ) as { after: { objects_erased: number; rows_kept: number } };
    expect(jobAudit.after).toMatchObject({ objects_erased: 1, rows_kept: 1 });
  });

  it('erases ticket attachments 180 days after closure and clears the references', async () => {
    const next = sequence([
      {
        rows: [
          {
            message_id: 'm1',
            shop_id: SHOP,
            attachments: [
              { key: `shops/${SHOP}/tickets/a.png`, bytes: 10 },
              { key: `shops/${SHOP}/tickets/b.pdf`, bytes: 20 },
            ],
          },
        ],
      },
      { rows: [] },
    ]);
    const pool = new FakePool((sql, params) => {
      if (/FROM ticket_message/.test(sql)) return next();
      return EMPTY(sql, params);
    });
    const { service, erase } = makeService(pool);
    const summary = await service.sweep(NOW);

    expect(summary.ticket_attachments).toBe(2);
    expect(erase.deleted).toEqual([
      `shops/${SHOP}/tickets/a.png`,
      `shops/${SHOP}/tickets/b.pdf`,
    ]);
    const clear = pool.matching(/UPDATE ticket_message SET attachments = '\[\]'::jsonb/);
    expect(clear).toHaveLength(1);
    expect(clear[0].params[0]).toEqual(['m1']);
    // 180-day horizon against ticket.resolved_at (closure)
    const select = pool.matching(/t\.resolved_at < \$1/);
    expect((select[0].params[0] as Date).toISOString()).toBe(
      daysCutoff(NOW, 180).toISOString(),
    );
  });

  it('erases feedback screenshots 180 days after submission and nulls the reference', async () => {
    const next = sequence([
      {
        rows: [
          {
            feedback_id: 'f1',
            shop_id: SHOP,
            screenshot_object_key: `shops/${SHOP}/feedback/s.png`,
          },
        ],
      },
      { rows: [] },
    ]);
    const pool = new FakePool((sql, params) => {
      if (/FROM feedback/.test(sql)) return next();
      return EMPTY(sql, params);
    });
    const { service, erase } = makeService(pool);
    const summary = await service.sweep(NOW);

    expect(summary.feedback_screenshots).toBe(1);
    expect(erase.deleted).toEqual([`shops/${SHOP}/feedback/s.png`]);
    expect(
      pool.matching(/UPDATE feedback SET screenshot_object_key = NULL/),
    ).toHaveLength(1);
    const select = pool.matching(/FROM feedback/);
    expect((select[0].params[0] as Date).toISOString()).toBe(
      daysCutoff(NOW, 180).toISOString(),
    );
  });

  it('refuses to erase an object key outside the row’s own shop prefix (INV-1)', async () => {
    const next = sequence([
      {
        rows: [
          {
            document_id: 'd1',
            shop_id: SHOP,
            object_key: 'shops/00000000-0000-0000-0000-000000000000/labels/x.pdf',
          },
        ],
      },
      { rows: [] },
    ]);
    const pool = new FakePool((sql, params) => {
      if (/FROM document/.test(sql) && /expires_at/.test(sql)) return next();
      return EMPTY(sql, params);
    });
    const { service, erase } = makeService(pool);

    await expect(service.sweep(NOW)).rejects.toThrow(/shop prefix/);
    expect(erase.deleted).toEqual([]);
    expect(pool.matching(/DELETE FROM document/)).toHaveLength(0);
  });

  it('never touches audit_log (append-only, §5.4/§12)', async () => {
    const pool = new FakePool(EMPTY);
    const { service } = makeService(pool);
    await service.sweep(NOW);
    expect(pool.matching(/audit_log/)).toHaveLength(0);
  });
});
