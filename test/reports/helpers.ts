import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { DocumentUrlSigner } from '../../src/modules/booking-ops/document-urls';
import { LocalFilesystemObjectStore, ObjectStore } from '../../src/modules/booking-ops/object-store';

/**
 * Test doubles for reports specs, following the test/booking-ops FnPool
 * pattern: regex-matched SQL handlers over a recorded call log.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const OTHER_SHOP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const JOB_ID = '99999999-9999-9999-9999-999999999999';
export const SCHEDULE_ID = '77777777-7777-7777-7777-777777777777';

export interface RecordedCall {
  sql: string;
  params: unknown[];
}

type HandlerResult = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => HandlerResult | undefined;

export class FnPool {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: Array<{ pattern: RegExp; fn: Handler }> = [];

  on(pattern: RegExp, rows: unknown[], rowCount?: number): this {
    this.handlers.push({
      pattern,
      fn: () => ({ rows, rowCount: rowCount ?? rows.length }),
    });
    return this;
  }

  onFn(pattern: RegExp, fn: Handler): this {
    this.handlers.push({ pattern, fn });
    return this;
  }

  readonly query = (sql: string, params?: unknown[]) => {
    this.calls.push({ sql, params: params ?? [] });
    for (const h of this.handlers) {
      if (h.pattern.test(sql)) {
        const r = h.fn(sql, params ?? []);
        if (r) return Promise.resolve({ rows: r.rows as never[], rowCount: r.rowCount });
      }
    }
    return Promise.resolve({ rows: [] as never[], rowCount: 0 });
  };

  matching(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => pattern.test(c.sql));
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

export function mockAudit() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    record: (entry: Record<string, unknown>) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}

export class FakeObjectStore implements ObjectStore {
  readonly puts: Array<{ key: string; bytes: Buffer }> = [];
  async put(key: string, bytes: Buffer): Promise<void> {
    this.puts.push({ key, bytes });
  }
  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    return `fake://signed/${key}?ttl=${ttlSeconds}`;
  }
}

/**
 * In-memory store that passes `instanceof LocalFilesystemObjectStore`, so
 * ReportsService takes the BYTES path without touching the filesystem.
 */
export class MemLocalObjectStore extends LocalFilesystemObjectStore {
  readonly objects = new Map<string, Buffer>();
  constructor() {
    super('/unused', (payload: string) => payload);
  }
  override async put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, bytes);
  }
  override async get(key: string): Promise<Buffer> {
    const b = this.objects.get(key);
    if (!b) throw new Error(`missing object ${key}`);
    return b;
  }
}

export function testSigner(): DocumentUrlSigner {
  return new DocumentUrlSigner({ get: () => 'test-signing-secret' } as unknown as ConfigService);
}

export function mockQueue() {
  const enqueued: Array<Record<string, unknown>> = [];
  return {
    enqueued,
    enqueueReportJob: (data: Record<string, unknown>) => {
      enqueued.push(data);
      return Promise.resolve();
    },
  };
}

export function mockNotifier() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    sendReportReady: (msg: Record<string, unknown>) => {
      sent.push(msg);
      return Promise.resolve();
    },
  };
}
