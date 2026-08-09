import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  ReconExportService,
  ReconExportSigner,
} from '../../src/modules/recon-freight/recon-export.service';
import { ReconDisputesBridge, ReconQueriesService } from '../../src/modules/recon-freight/recon-queries.service';
import { AuditService } from '../../src/audit/audit.service';
import { LocalFilesystemObjectStore } from '../../src/modules/booking-ops/object-store';
import { OPEN_DISPUTE_STATES } from '../../src/modules/recon-freight/recon-freight.types';
import { BATCH_ID, FnPool, MEMBER_ID, SHOP_ID, fakeAudit, fakeStore } from './helpers';

/**
 * §9.17.2 dispute export (§3.14 counting rule, ADD-42 evidence reference,
 * S-26 signed download) and the dashboard disputes feed (§3.14 + §3.28).
 */

const EXPORT_ROW = {
  batch_reference: 'FREIGHT-20260731-1',
  awb_normalized: 'DL0087412391',
  charge_type: 'FORWARD',
  invoiced_amount: '211.50',
  invoiced_weight_kg: '1.500',
  expected_amount: '211.50',
  audited_amount: '211.50',
  flag_awb_not_found: false,
  flag_weight_mismatch: true,
  flag_amount_mismatch: false,
  flag_review: false,
  workflow_state: 'DISPUTE_PREPARED',
  shipper_company: 'Acme',
  invoice_reference: 'INV-9',
  invoice_date: '2026-07-31',
  shipment_date: '2026-07-01',
  origin_station: 'AMD',
  destination_station: 'DEL',
  filename: 'invoice.csv',
  uploaded_at: '2026-08-01T10:00:00.000Z',
  remark: 'reweigh dispute',
  dispute_evidence_object_key: `shops/${SHOP_ID}/reweigh/img-1.png`,
};

function harness(pool: FnPool) {
  const signer = new ReconExportSigner(new ConfigService({ DOCUMENT_SIGNING_SECRET: 'test-secret' }));
  const store = fakeStore((p) => signer.hmac(p));
  const audit = fakeAudit();
  const service = new ReconExportService(
    pool.asPool(),
    store as unknown as LocalFilesystemObjectStore,
    audit as unknown as AuditService,
    signer,
  );
  return { service, store, audit, signer };
}

describe('dispute export (§9.17.2)', () => {
  it('exports the §3.14 open-dispute rows with reference fields, flags, expectations and ADD-42 evidence', async () => {
    const pool = new FnPool();
    pool.on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, [EXPORT_ROW]);
    const { service, store, audit } = harness(pool);

    const result = await service.exportDisputes({ shopId: SHOP_ID, actorMemberId: MEMBER_ID });
    expect(result.rowCount).toBe(1);
    expect(result.objectKey).toMatch(new RegExp(`^shops/${SHOP_ID}/recon/disputes/`)); // INV-1

    // The SQL selects exactly the §3.14 open states.
    const select = pool.matching(/FROM recon_freight_row/)[0];
    expect(select.params[1]).toEqual(OPEN_DISPUTE_STATES);

    const csv = store.files.get(result.objectKey)!.toString('utf8');
    const [header, line] = csv.trim().split('\n');
    for (const col of [
      'batch_reference', 'awb', 'charge_type', 'expected_amount', 'audited_amount',
      'flag_weight_mismatch', 'workflow_state', 'dispute_evidence_object_key',
    ]) {
      expect(header).toContain(col);
    }
    expect(line).toContain('DL0087412391');
    expect(line).toContain('211.50');
    expect(line).toContain(`shops/${SHOP_ID}/reweigh/img-1.png`); // ADD-42
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'recon.dispute_exported' }),
    );
  });

  it('neutralizes formula content in the export (§8.7)', async () => {
    const pool = new FnPool();
    pool.on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, [
      { ...EXPORT_ROW, shipper_company: '=HYPERLINK("http://evil")' },
    ]);
    const { service, store } = harness(pool);
    const result = await service.exportDisputes({ shopId: SHOP_ID, actorMemberId: MEMBER_ID });
    const csv = store.files.get(result.objectKey)!.toString('utf8');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain(',=HYPERLINK');
  });

  it('the S-26 signed URL round-trips; tampered or cross-shop access is refused (INV-1)', async () => {
    const pool = new FnPool();
    pool.on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, [EXPORT_ROW]);
    const { service } = harness(pool);
    const result = await service.exportDisputes({ shopId: SHOP_ID, actorMemberId: MEMBER_ID });

    const url = new URL(`http://localhost${result.downloadUrl}`);
    const key = url.searchParams.get('key')!;
    const expires = Number(url.searchParams.get('expires'));
    const signature = url.searchParams.get('signature')!;

    const bytes = await service.readExport({ shopId: SHOP_ID, key, expires, signature });
    expect(bytes).not.toBeNull();
    expect(bytes!.toString('utf8')).toContain('DL0087412391');

    // Bad signature. The flip must be conditional: the signature is hex, so
    // forcing the last character to '0' is a no-op 1 time in 16 — the "tampered"
    // signature is then the real one and the read correctly succeeds, failing
    // this assertion at random. Same guard as the OAuth HMAC test.
    expect(
      await service.readExport({
        shopId: SHOP_ID,
        key,
        expires,
        signature: signature.replace(/.$/, signature.endsWith('0') ? '1' : '0'),
      }),
    ).toBeNull();
    // Another Shop's session can never read it (INV-1).
    expect(
      await service.readExport({ shopId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', key, expires, signature }),
    ).toBeNull();
    // Expired.
    expect(
      await service.readExport({ shopId: SHOP_ID, key, expires: 1, signature }),
    ).toBeNull();
  });
});

describe('openDisputesCount (§3.14 + §3.28 — the dashboard feed)', () => {
  it('counts open-state rows plus one per MISMATCH batch', async () => {
    const pool = new FnPool();
    pool.on(/SELECT \(\s*SELECT count\(\*\) FROM recon_freight_row/, [{ n: '7' }]);
    const queries = new ReconQueriesService(pool.asPool());
    const count = await queries.openDisputesCount(SHOP_ID);
    expect(count).toBe(7);
    const call = pool.calls[0];
    expect(call.sql).toContain('workflow_state = ANY'); // §3.14 row part
    expect(call.sql).toContain("control_total_state = 'MISMATCH'"); // §3.28 batch part
    expect(call.params[0]).toBe(SHOP_ID); // INV-1
    expect(call.params[1]).toEqual(OPEN_DISPUTE_STATES);
  });

  it('ReconDisputesBridge satisfies the dashboard RECON_DISPUTES_PROVIDER seam', async () => {
    const pool = new FnPool();
    pool.on(/recon_freight_row/, [{ n: '3' }]);
    const bridge = new ReconDisputesBridge(new ReconQueriesService(pool.asPool()));
    await expect(bridge.countOpenDisputes(SHOP_ID)).resolves.toBe(3);
  });

  it('batch MISMATCH items do not count once resolved', async () => {
    const pool = new FnPool();
    pool.on(/recon_freight_row/, [{ n: '0' }]);
    const queries = new ReconQueriesService(pool.asPool());
    await queries.openDisputesCount(SHOP_ID);
    expect(pool.calls[0].sql).toContain("state <> 'RESOLVED'");
  });
});
