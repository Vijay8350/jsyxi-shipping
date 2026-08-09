import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DocumentsService } from '../../src/modules/booking-ops/documents.service';
import { DocumentUrlSigner } from '../../src/modules/booking-ops/document-urls';
import { LocalFilesystemObjectStore } from '../../src/modules/booking-ops/object-store';
import { SIGNED_URL_TTL_SECONDS } from '../../src/modules/booking-ops/booking-ops.types';
import { DOCUMENT_ID, FnPool, OTHER_SHOP_ID, SHOP_ID } from './helpers';

/**
 * S-26 signed document URLs: HMAC-signed, 10-minute lifetime, shop-scoped
 * at download (INV-1).
 */

function env() {
  const pool = new FnPool();
  const signer = new DocumentUrlSigner({ get: () => 'test-secret' } as never);
  const dir = mkdtempSync(join(tmpdir(), 'booking-ops-'));
  const store = new LocalFilesystemObjectStore(dir, (payload) => signer.hmac(payload));
  const service = new DocumentsService(pool.asPool(), signer, store);
  return { pool, signer, store, dir, service };
}

function signed(documentId: string, signer: DocumentUrlSigner) {
  const url = signer.signDocumentUrl(documentId);
  const expires = Number(/expires=(\d+)/.exec(url)![1]);
  const signature = /signature=([0-9a-f]+)/.exec(url)![1];
  return { url, expires, signature };
}

describe('DocumentUrlSigner (S-26)', () => {
  it('signs a 10-minute URL and verifies it', () => {
    const signer = new DocumentUrlSigner({ get: () => 'test-secret' } as never);
    const { url, expires, signature } = signed(DOCUMENT_ID, signer);
    expect(url).toContain(`/documents/${DOCUMENT_ID}/download?`);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS);
    expect(signer.verifySignature(DOCUMENT_ID, expires, signature)).toBe(true);
    expect(signer.verifySignature(DOCUMENT_ID, expires, 'deadbeef')).toBe(false);
    expect(signer.verifySignature(OTHER_SHOP_ID, expires, signature)).toBe(false);
  });

  it('expires after the S-26 lifetime', () => {
    const signer = new DocumentUrlSigner({ get: () => 'test-secret' } as never);
    const now = new Date('2026-07-31T12:00:00.000Z');
    const url = signer.signDocumentUrl(DOCUMENT_ID, SIGNED_URL_TTL_SECONDS, now);
    const expires = Number(/expires=(\d+)/.exec(url)![1]);
    expect(signer.isExpired(expires, new Date(now.getTime() + 599_000))).toBe(false);
    expect(signer.isExpired(expires, new Date(now.getTime() + 600_000))).toBe(true);
  });
});

describe('DocumentsService.getDownload — expiry + shop scope (S-26, INV-1)', () => {
  it('serves bytes for a valid, in-scope, unexpired URL', async () => {
    const { pool, signer, store, dir, service } = env();
    try {
      const key = `shops/${SHOP_ID}/manifests/20260731/MF-20260731-0001.pdf`;
      const content = Buffer.from('%PDF-1.4 test bytes', 'latin1');
      await store.put(key, content);
      pool.on(/FROM document\s+WHERE shop_id/, [{ object_key: key }]);

      const { expires, signature } = signed(DOCUMENT_ID, signer);
      const result = await service.getDownload({
        shopId: SHOP_ID,
        documentId: DOCUMENT_ID,
        expires,
        signature,
      });
      expect(result.kind).toBe('BYTES');
      if (result.kind === 'BYTES') {
        expect(result.bytes.equals(content)).toBe(true);
        expect(result.filename).toBe('MF-20260731-0001.pdf');
      }
      // The document load is shop-scoped (INV-1).
      expect(pool.matching(/FROM document\s+WHERE shop_id/)[0].params).toEqual([SHOP_ID, DOCUMENT_ID]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an expired URL with 410', async () => {
    const { pool, signer, dir, service } = env();
    try {
      const past = new Date(Date.now() - 20 * 60 * 1000);
      const url = signer.signDocumentUrl(DOCUMENT_ID, SIGNED_URL_TTL_SECONDS, past);
      const expires = Number(/expires=(\d+)/.exec(url)![1]);
      const signature = /signature=([0-9a-f]+)/.exec(url)![1];
      await expect(
        service.getDownload({ shopId: SHOP_ID, documentId: DOCUMENT_ID, expires, signature }),
      ).rejects.toMatchObject({
        response: { statusCode: 410, message: expect.stringContaining('expired') },
      });
      expect(pool.matching(/FROM document/)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a bad signature with 403', async () => {
    const { signer, dir, service } = env();
    try {
      const { expires } = signed(DOCUMENT_ID, signer);
      await expect(
        service.getDownload({
          shopId: SHOP_ID,
          documentId: DOCUMENT_ID,
          expires,
          signature: 'f'.repeat(64),
        }),
      ).rejects.toMatchObject({
        response: { statusCode: 403, message: expect.stringContaining('signature') },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("another shop's document reads as 404 even with a valid signature (INV-1)", async () => {
    const { pool, signer, dir, service } = env();
    try {
      pool.on(/FROM document\s+WHERE shop_id/, []); // shop-scoped load finds nothing
      const { expires, signature } = signed(DOCUMENT_ID, signer);
      await expect(
        service.getDownload({ shopId: OTHER_SHOP_ID, documentId: DOCUMENT_ID, expires, signature }),
      ).rejects.toMatchObject({
        response: { statusCode: 404, message: 'document not found' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the local object store refuses key traversal (INV-1)', async () => {
    const { store, dir } = env();
    try {
      await expect(store.put('../escape.pdf', Buffer.from('x'))).rejects.toThrow('invalid object key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
