import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { SIGNED_URL_TTL_SECONDS } from './booking-ops.types';

/**
 * S-26 (§7.4): document signed URLs — 10-minute lifetime, HMAC-signed,
 * shop-scoped at download (INV-1). The local ObjectStore driver returns app
 * URLs of the form `/documents/:id/download?expires=..&signature=..`; the
 * signature is HMAC-SHA256 over `doc:{documentId}:{expires}`.
 *
 * The secret comes from DOCUMENT_SIGNING_SECRET; the dev fallback exists so
 * tests and local runs work, and must be overridden in production (§5.7
 * control 2 requires TLS on every signed document URL — an ops concern).
 */
@Injectable()
export class DocumentUrlSigner {
  private readonly secret: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.secret =
      config.get<string>('DOCUMENT_SIGNING_SECRET') ?? 'dev-only-document-signing-secret';
  }

  hmac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  /** The signed app URL for a document row (S-26 lifetime). */
  signDocumentUrl(
    documentId: string,
    ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
    now: Date = new Date(),
  ): string {
    const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
    const signature = this.hmac(`doc:${documentId}:${expires}`);
    return `/documents/${documentId}/download?expires=${expires}&signature=${signature}`;
  }

  verifySignature(documentId: string, expires: number, signature: string): boolean {
    const expected = Buffer.from(this.hmac(`doc:${documentId}:${expires}`), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  isExpired(expires: number, now: Date = new Date()): boolean {
    return expires * 1000 <= now.getTime();
  }
}
