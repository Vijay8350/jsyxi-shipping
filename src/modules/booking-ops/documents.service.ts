import {
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { DocumentUrlSigner } from './document-urls';
import { LocalFilesystemObjectStore, OBJECT_STORE, ObjectStore } from './object-store';

/**
 * Signed document downloads (S-26, §9.9.1). The URL carries expires +
 * HMAC signature; the document row is loaded SHOP-SCOPED (INV-1) — another
 * shop's document id is indistinguishable from a missing one. Expired URLs
 * get 410, bad signatures 403. Re-download is allowed in RESTRICTED (§3.11)
 * — this path never checks account state on purpose.
 */
export type DocumentDownload =
  | { kind: 'BYTES'; bytes: Buffer; filename: string }
  | { kind: 'REDIRECT'; url: string };

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly signer: DocumentUrlSigner,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async getDownload(args: {
    shopId: string;
    documentId: string;
    expires: number;
    signature: string;
  }): Promise<DocumentDownload> {
    if (!this.signer.verifySignature(args.documentId, args.expires, args.signature)) {
      throw new ForbiddenException('invalid document URL signature (S-26)');
    }
    if (this.signer.isExpired(args.expires)) {
      throw new GoneException('document URL expired (S-26: 10 minutes)');
    }
    // INV-1: shop-scoped load — cross-shop ids read as 404.
    const { rows } = await this.pool.query<{ object_key: string }>(
      `SELECT object_key FROM document
        WHERE shop_id = $1 AND document_id = $2`,
      [args.shopId, args.documentId],
    );
    const doc = rows[0];
    if (!doc) throw new NotFoundException('document not found');

    if (this.store instanceof LocalFilesystemObjectStore) {
      const filename = doc.object_key.split('/').pop() ?? 'document.pdf';
      return { kind: 'BYTES', bytes: await this.store.get(doc.object_key), filename };
    }
    // The S3 driver slots in here (§9.9.1): redirect to its signed URL.
    return { kind: 'REDIRECT', url: await this.store.getSignedUrl(doc.object_key, 60) };
  }
}
