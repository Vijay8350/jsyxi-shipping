import { timingSafeEqual } from 'crypto';
import { DocumentUrlSigner } from '../booking-ops/document-urls';

/**
 * Signed report-download URLs — S-26 semantics (HMAC-signed, expiring,
 * shop-scoped at download) on the report object key convention
 * `shops/{shopId}/reports/{reportJobId}.csv`. The signature is
 * HMAC-SHA256 over `report:{reportJobId}:{expires}`, produced by the
 * booking-ops DocumentUrlSigner — the module's single HMAC authority — so
 * report links rotate with the same DOCUMENT_SIGNING_SECRET as documents.
 *
 * Exports are delivered as expiring authorized links, never attachments
 * (A1-12).
 */
export function reportObjectKey(shopId: string, reportJobId: string): string {
  return `shops/${shopId}/reports/${reportJobId}.csv`;
}

export function signReportDownloadUrl(
  signer: DocumentUrlSigner,
  reportJobId: string,
  ttlSeconds: number,
  now: Date = new Date(),
): { url: string; expiresAt: Date } {
  const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const signature = signer.hmac(`report:${reportJobId}:${expires}`);
  return {
    url: `/reports/jobs/${reportJobId}/download?expires=${expires}&signature=${signature}`,
    expiresAt: new Date(expires * 1000),
  };
}

export function verifyReportSignature(
  signer: DocumentUrlSigner,
  reportJobId: string,
  expires: number,
  signature: string,
): boolean {
  const expected = Buffer.from(signer.hmac(`report:${reportJobId}:${expires}`), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
