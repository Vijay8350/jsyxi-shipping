import { createHmac } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, normalize } from 'path';

/**
 * §9.9.1 document storage: S3-compatible object storage with signed URLs
 * (S-26). `ObjectStore` is the seam — an S3 driver slots in later without
 * touching the document flow. The local filesystem driver is rooted at an
 * env-configured dir (OBJECT_STORE_DIR) and every object key is prefixed
 * `shops/{shop_id}/...` by callers (INV-1: the object path is shop-scoped).
 *
 * The local driver cannot produce a vendor signed URL, so it returns an
 * app URL carrying an HMAC signature over (key, expires); the document-row
 * flow instead signs over (document_id, expires) and is served by
 * DocumentsController — see document-urls.ts, the single HMAC authority.
 */
export interface ObjectStore {
  put(key: string, bytes: Buffer): Promise<void>;
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
}

export const OBJECT_STORE = Symbol('OBJECT_STORE');

export class LocalFilesystemObjectStore implements ObjectStore {
  constructor(
    private readonly rootDir: string,
    /** HMAC signer shared with DocumentUrlSigner: (payload) => hex. */
    private readonly hmac: (payload: string) => string,
  ) {}

  private resolve(key: string): string {
    // INV-1: keys are shop-prefixed by callers; refuse traversal outright.
    if (key.includes('..') || key.startsWith('/') || key.includes('\\')) {
      throw new Error(`invalid object key: ${key}`);
    }
    return normalize(join(this.rootDir, key));
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  /** Local-driver read, used by the download endpoint to serve bytes. */
  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = this.hmac(`key:${key}:${expires}`);
    return (
      `/documents/download?key=${encodeURIComponent(key)}` +
      `&expires=${expires}&signature=${signature}`
    );
  }
}
