import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  LocalFilesystemObjectStore,
  OBJECT_STORE,
  ObjectStore,
} from '../booking-ops/object-store';
import { TICKET_ATTACHMENT_MAX_BYTES } from './support.types';

/**
 * Ticket attachment upload/read (§9.18, §5.1).
 *
 * The DTOs have always taken {key, bytes} object references while the binary
 * upload itself was "a binding point for the parent" — meaning nothing
 * produced those keys, so no merchant could ever attach anything. This is that
 * binding point.
 *
 * INV-1 is enforced by the key shape, not by trusting the caller: every key is
 * minted as `shops/{shop_id}/tickets/...` here, and every read re-derives the
 * expected prefix from the session's shop before touching the store. A key
 * arriving from a client is never used as-is.
 *
 * Uploads arrive base64 in JSON rather than multipart: it keeps the transport
 * dependency-free, and §5.1 caps a file at 10 MB, which stays a manageable
 * request body. The trade is ~33% wire overhead, paid on an infrequent action.
 */

/** §5.1 permits documents and images on a ticket, nothing executable. */
const ALLOWED = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
  ['csv', 'text/csv'],
  ['txt', 'text/plain'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['xls', 'application/vnd.ms-excel'],
]);

export interface UploadedAttachment {
  key: string;
  bytes: number;
  filename: string;
  contentType: string;
}

@Injectable()
export class TicketAttachmentService {
  constructor(@Inject(OBJECT_STORE) private readonly store: ObjectStore) {}

  private prefix(shopId: string): string {
    return `shops/${shopId}/tickets/`;
  }

  /**
   * Store one file and return the reference the ticket DTOs expect.
   * The client's filename is never used as a path component — only its
   * extension is trusted, and even that only to pick a content type.
   */
  async upload(input: {
    shopId: string;
    filename: string;
    dataBase64: string;
  }): Promise<UploadedAttachment> {
    const name = String(input.filename ?? '').trim();
    if (!name) throw new BadRequestException('filename is required');

    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const contentType = ALLOWED.get(ext);
    if (!contentType) {
      throw new BadRequestException(
        `unsupported file type ".${ext}" — allowed: ${[...ALLOWED.keys()].join(', ')}`,
      );
    }

    let buf: Buffer;
    try {
      // strict:true rejects non-base64 rather than silently truncating.
      buf = Buffer.from(input.dataBase64 ?? '', 'base64');
    } catch {
      throw new BadRequestException('file data is not valid base64');
    }
    if (buf.length === 0) throw new BadRequestException('file is empty');
    if (buf.length > TICKET_ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException(
        `file exceeds the ${Math.round(TICKET_ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB limit (§5.1)`,
      );
    }

    // A random id owns the path; the display name is carried separately, so a
    // hostile filename cannot escape the prefix or collide with another file.
    const key = `${this.prefix(input.shopId)}${randomUUID()}.${ext}`;
    await this.store.put(key, buf);

    return { key, bytes: buf.length, filename: name, contentType };
  }

  /**
   * Read an attachment back. `shopId` comes from the session, never the
   * request body — a key belonging to another shop is refused as 404 so a
   * probe cannot distinguish "not yours" from "does not exist" (INV-1).
   */
  async read(shopId: string, key: string): Promise<{ bytes: Buffer; contentType: string }> {
    if (!key || !key.startsWith(this.prefix(shopId)) || key.includes('..')) {
      throw new NotFoundException('attachment not found');
    }
    const ext = (key.split('.').pop() ?? '').toLowerCase();
    const contentType = ALLOWED.get(ext) ?? 'application/octet-stream';
    if (!(this.store instanceof LocalFilesystemObjectStore)) {
      // The S3 driver serves its own signed URL; this path is local-only.
      throw new NotFoundException('attachment not readable from this driver');
    }
    try {
      return { bytes: await this.store.get(key), contentType };
    } catch {
      throw new NotFoundException('attachment not found');
    }
  }

  /**
   * Staff read: an admin is not scoped to one shop, so the shop is taken from
   * the key itself. Still refuses traversal and anything outside the ticket
   * namespace, so an admin cannot walk into label or invoice objects.
   */
  async readAsAdmin(key: string): Promise<{ bytes: Buffer; contentType: string }> {
    if (!key || key.includes('..') || !/^shops\/[0-9a-f-]{36}\/tickets\//i.test(key)) {
      throw new NotFoundException('attachment not found');
    }
    const shopId = key.split('/')[1];
    return this.read(shopId, key);
  }
}
