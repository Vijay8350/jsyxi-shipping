import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption (§5.7 control 1).
 *
 * A random per-record data key encrypts the blob (AES-256-GCM); the data key
 * is itself encrypted by the KMS-managed master key. Record layout:
 *
 *   [ wrapped data key (60 bytes) ][ sealed blob (12 iv + 16 tag + ct) ]
 *
 * Master-key rotation re-encrypts only the 60-byte wrapped-key prefix, never
 * the stored record. Plaintext exists only inside the calling worker at call
 * time and never enters logs, queues or error payloads (INV-18).
 */

const MASTER_KEY_LEN = 32;
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;
const WRAPPED_KEY_LEN = MASTER_KEY_LEN + GCM_IV_LEN + GCM_TAG_LEN; // 60

function gcmSeal(key: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(GCM_IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function gcmOpen(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, GCM_IV_LEN);
  const tag = sealed.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN);
  const ct = sealed.subarray(GCM_IV_LEN + GCM_TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export class EnvelopeCipher {
  private constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== MASTER_KEY_LEN) {
      throw new Error('master key must be 32 bytes');
    }
  }

  static fromHex(hex: string): EnvelopeCipher {
    if (!hex) throw new Error('MASTER_KEY_HEX is not configured');
    return new EnvelopeCipher(Buffer.from(hex, 'hex'));
  }

  encrypt(plaintext: Buffer | string): Buffer {
    const dataKey = randomBytes(MASTER_KEY_LEN);
    const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    return Buffer.concat([gcmSeal(this.masterKey, dataKey), gcmSeal(dataKey, pt)]);
  }

  decrypt(record: Buffer): Buffer {
    const dataKey = gcmOpen(this.masterKey, record.subarray(0, WRAPPED_KEY_LEN));
    return gcmOpen(dataKey, record.subarray(WRAPPED_KEY_LEN));
  }

  /** Re-wrap the data key under a new master key without touching the blob. */
  rotateMaster(record: Buffer, newMasterHex: string): Buffer {
    const dataKey = gcmOpen(this.masterKey, record.subarray(0, WRAPPED_KEY_LEN));
    const newMaster = Buffer.from(newMasterHex, 'hex');
    if (newMaster.length !== MASTER_KEY_LEN) {
      throw new Error('new master key must be 32 bytes');
    }
    return Buffer.concat([gcmSeal(newMaster, dataKey), record.subarray(WRAPPED_KEY_LEN)]);
  }
}
