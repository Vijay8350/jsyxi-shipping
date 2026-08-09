import { rm } from 'fs/promises';
import { join, normalize } from 'path';

/**
 * §5.5 object-storage erasure seam. The booking-ops `ObjectStore`
 * (src/modules/booking-ops/object-store.ts) has no delete — this module may
 * not edit sibling files, so erasure goes through this narrow interface.
 *
 * BINDING POINT for the parent: the intended end state is a `deleteObject`
 * method on the booking-ops ObjectStore itself; once that exists, bind
 * OBJECT_ERASE to the same OBJECT_STORE instance and delete the local
 * filesystem driver below. Until then HealthModule binds OBJECT_ERASE to
 * LocalFilesystemObjectErase rooted at the same OBJECT_STORE_DIR.
 *
 * Key rules mirror LocalFilesystemObjectStore: callers pass shop-prefixed
 * keys (INV-1) and traversal is refused outright.
 */
export interface ObjectEraseStore {
  /** Idempotent: deleting an already-absent object succeeds. */
  delete(key: string): Promise<void>;
}

export const OBJECT_ERASE = Symbol('OBJECT_ERASE');

export class LocalFilesystemObjectErase implements ObjectEraseStore {
  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    if (key.includes('..') || key.startsWith('/') || key.includes('\\')) {
      throw new Error(`invalid object key: ${key}`);
    }
    return normalize(join(this.rootDir, key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true }); // idempotent per contract
  }
}
