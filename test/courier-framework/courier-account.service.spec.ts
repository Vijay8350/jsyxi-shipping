import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../src/modules/courier-framework/adapter-registry';
import { CourierAccountService } from '../../src/modules/courier-framework/courier-account.service';
import { FakeCourierAdapter } from '../../src/modules/courier-framework/fake/fake-courier-adapter';
import { CredentialsVaultService } from '../../src/modules/courier-framework/vault.service';
import {
  ACCOUNT_ID,
  COURIER_ID,
  mockAudit,
  mockConfig,
  mockPool,
  OWNER_ID,
  routeBySql,
  SHOP_ID,
} from './helpers';

/**
 * Courier account management (§9.3.3) + ADD-18. Every assertion that
 * touches credentials checks the OUTGOING shapes (SQL, views, audit rows) —
 * plaintext values never appear in them (INV-18).
 */
const COURIER_ROW = {
  courier_id: COURIER_ID,
  code: 'FAKE',
  name: 'Fake Courier',
  auth_pattern: 'KEY_PASTE',
  is_active: true,
};

const FIELD_ROWS = [
  {
    key: 'api_token',
    label: 'API token',
    type: 'password',
    is_secret: true,
    is_required: true,
    validation_regex: null,
    display_order: 1,
  },
];

const ACCOUNT_ROW = {
  courier_account_id: ACCOUNT_ID,
  shop_id: SHOP_ID,
  courier_id: COURIER_ID,
  courier_code: 'FAKE',
  mode: 'TEST',
  credentials_test_encrypted: null as Buffer | null,
  credentials_live_encrypted: null as Buffer | null,
  health_state: 'UNVERIFIED',
  disabled_at: null as string | null,
  webhook_url_token: 'url-token-1',
  webhook_secret_encrypted: null as Buffer | null,
  last_event_received_at: null as string | null,
  version: 1,
};

function setup() {
  const { pool } = mockPool();
  const config = mockConfig();
  const vault = new CredentialsVaultService(pool as never, config as never);
  const audit = mockAudit();
  const caller = {
    loadAccount: vi.fn().mockResolvedValue({ ...ACCOUNT_ROW }),
    call: vi.fn().mockResolvedValue({ found: false, awb: null }),
  };
  const registry = new AdapterRegistry({
    FAKE: (ctx) => new FakeCourierAdapter({ courierCode: ctx.courierCode }, ctx.now),
  });
  const health = { transition: vi.fn().mockResolvedValue(true) };
  const webhookStats = {
    last24h: vi.fn().mockResolvedValue({ events24h: 3, signatureFailures24h: 1 }),
    recordEventReceived: vi.fn(),
    recordSignatureFailure: vi.fn(),
  };
  const service = new CourierAccountService(
    pool as never,
    config as never,
    vault,
    audit as never,
    caller as never,
    registry,
    health as never,
    webhookStats as never,
  );
  return { pool, config, vault, audit, caller, registry, health, webhookStats, service };
}

describe('CourierAccountService (§9.3.3, ADD-18)', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  describe('connectAccount', () => {
    function routeConnect(pool: ReturnType<typeof mockPool>['pool']) {
      routeBySql(pool.query, [
        ['FROM courier WHERE courier_id', () => ({ rows: [COURIER_ROW], rowCount: 1 })],
        ['FROM courier_credential_field', () => ({ rows: FIELD_ROWS, rowCount: 1 })],
        [
          'INSERT INTO courier_account',
          () => ({
            rows: [{ courier_account_id: ACCOUNT_ID, created_at: '2026-02-01T00:00:00Z' }],
            rowCount: 1,
          }),
        ],
      ]);
    }

    it('creates with mode TEST by default, writing ONLY the test blob (RW-20)', async () => {
      routeConnect(ctx.pool);
      const view = await ctx.service.connectAccount(SHOP_ID, OWNER_ID, {
        courierId: COURIER_ID,
        credentials: { api_token: 'testtoken123' },
      });
      const [sql, params] = ctx.pool.query.mock.calls.find(([s]: [string]) =>
        s.includes('INSERT INTO courier_account'),
      ) as [string, unknown[]];
      expect(sql).toContain('credentials_test_encrypted');
      expect(sql).not.toContain('credentials_live_encrypted');
      // INV-18: no plaintext anywhere in the outgoing params.
      expect(JSON.stringify(params.map((p) => (Buffer.isBuffer(p) ? '<blob>' : p)))).not.toContain(
        'testtoken123',
      );
      const blob = params.find((p) => Buffer.isBuffer(p)) as Buffer;
      expect(blob.toString('utf8')).not.toContain('testtoken123');

      expect(view.mode).toBe('TEST');
      expect(view.healthState).toBe('UNVERIFIED');
      // Masked display only (§5.7 control 3).
      expect(view.credentials).toEqual([{ key: 'api_token', isSecret: true, set: true }]);
      expect(JSON.stringify(view)).not.toContain('testtoken123');
      expect(view.webhookUrl).toMatch(
        /^https:\/\/api\.jsyxi\.test\/hooks\/fake\//,
      );
    });

    it('writes ONLY the live blob when connecting in LIVE mode (RW-20)', async () => {
      routeConnect(ctx.pool);
      await ctx.service.connectAccount(SHOP_ID, OWNER_ID, {
        courierId: COURIER_ID,
        mode: 'LIVE',
        credentials: { api_token: 'livetoken456' },
      });
      const [sql] = ctx.pool.query.mock.calls.find(([s]: [string]) =>
        s.includes('INSERT INTO courier_account'),
      ) as [string];
      expect(sql).toContain('credentials_live_encrypted');
      expect(sql).not.toContain('credentials_test_encrypted');
    });

    it('audits the create with masked after-values (§12, INV-18)', async () => {
      routeConnect(ctx.pool);
      await ctx.service.connectAccount(SHOP_ID, OWNER_ID, {
        courierId: COURIER_ID,
        credentials: { api_token: 'testtoken123' },
      });
      const entry = ctx.audit.record.mock.calls[0][0];
      expect(entry.action).toBe('courier_account.create');
      expect(entry.actorId).toBe(OWNER_ID);
      expect(entry.after).toEqual({
        courierCode: 'FAKE',
        mode: 'TEST',
        fieldsSet: ['api_token'],
      });
      expect(JSON.stringify(entry)).not.toContain('testtoken123');
    });

    it('rejects invalid credentials without leaking values', async () => {
      routeConnect(ctx.pool);
      await expect(
        ctx.service.connectAccount(SHOP_ID, OWNER_ID, {
          courierId: COURIER_ID,
          credentials: { bogus: 'x' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps the (shop_id, courier_id) unique violation to a conflict', async () => {
      routeBySql(ctx.pool.query, [
        ['FROM courier WHERE courier_id', () => ({ rows: [COURIER_ROW], rowCount: 1 })],
        ['FROM courier_credential_field', () => ({ rows: FIELD_ROWS, rowCount: 1 })],
        [
          'INSERT INTO courier_account',
          () => {
            throw Object.assign(new Error('duplicate'), { code: '23505' });
          },
        ],
      ]);
      await expect(
        ctx.service.connectAccount(SHOP_ID, OWNER_ID, {
          courierId: COURIER_ID,
          credentials: { api_token: 'testtoken123' },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('switchMode (RW-20, §12)', () => {
    it('updates only the mode column — never either credential blob', async () => {
      routeBySql(ctx.pool.query, [
        ['UPDATE courier_account SET mode', () => ({ rows: [{}], rowCount: 1 })],
      ]);
      const result = await ctx.service.switchMode(SHOP_ID, OWNER_ID, ACCOUNT_ID, 'LIVE');
      expect(result.mode).toBe('LIVE');
      const [sql] = ctx.pool.query.mock.calls[0] as [string];
      expect(sql).not.toContain('credentials_test_encrypted');
      expect(sql).not.toContain('credentials_live_encrypted');
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'courier_account.mode_change',
          before: { mode: 'TEST' },
          after: { mode: 'LIVE' },
        }),
      );
    });

    it('refuses on a disabled account', async () => {
      ctx.caller.loadAccount.mockResolvedValue({ ...ACCOUNT_ROW, disabled_at: '2026-01-01' });
      await expect(
        ctx.service.switchMode(SHOP_ID, OWNER_ID, ACCOUNT_ID, 'LIVE'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('replaceCredentials (§5.7 control 3, §12)', () => {
    it('rewrites only the current mode blob, bumps version, audits masked before/after', async () => {
      const existingBlob = ctx.vault.encrypt({ api_token: 'oldtoken111' });
      ctx.caller.loadAccount.mockResolvedValue({
        ...ACCOUNT_ROW,
        credentials_test_encrypted: existingBlob,
      });
      routeBySql(ctx.pool.query, [
        ['FROM courier_credential_field', () => ({ rows: FIELD_ROWS, rowCount: 1 })],
        ['UPDATE courier_account', () => ({ rows: [], rowCount: 1 })],
      ]);
      const result = await ctx.service.replaceCredentials(SHOP_ID, OWNER_ID, ACCOUNT_ID, {
        api_token: 'newtoken999',
      });
      const [sql, params] = ctx.pool.query.mock.calls.find(([s]: [string]) =>
        s.includes('UPDATE courier_account'),
      ) as [string, unknown[]];
      expect(sql).toContain('credentials_test_encrypted = $3');
      expect(sql).toContain('version = version + 1');
      expect(sql).not.toContain('credentials_live_encrypted');
      expect(JSON.stringify(params.map((p) => (Buffer.isBuffer(p) ? '<blob>' : p)))).not.toContain(
        'newtoken999',
      );

      expect(result.credentials).toEqual([{ key: 'api_token', isSecret: true, set: true }]);
      const entry = ctx.audit.record.mock.calls[0][0];
      expect(entry.action).toBe('courier_account.credential_replace');
      expect(JSON.stringify(entry)).not.toContain('newtoken999');
      expect(JSON.stringify(entry)).not.toContain('oldtoken111');
    });
  });

  describe('setEnabled (§9.3.3, §3.21)', () => {
    it('disable sets DISABLED + disabled_at and audits', async () => {
      routeBySql(ctx.pool.query, [
        ['UPDATE courier_account', () => ({ rows: [{}], rowCount: 1 })],
      ]);
      const result = await ctx.service.setEnabled(SHOP_ID, OWNER_ID, ACCOUNT_ID, false);
      expect(result.healthState).toBe('DISABLED');
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'courier_account.disable' }),
      );
    });

    it('enable clears disabled_at back to UNVERIFIED and audits', async () => {
      ctx.caller.loadAccount.mockResolvedValue({
        ...ACCOUNT_ROW,
        disabled_at: '2026-01-15T00:00:00Z',
        health_state: 'DISABLED',
      });
      routeBySql(ctx.pool.query, [
        ['UPDATE courier_account', () => ({ rows: [{}], rowCount: 1 })],
      ]);
      const result = await ctx.service.setEnabled(SHOP_ID, OWNER_ID, ACCOUNT_ID, true);
      expect(result.healthState).toBe('UNVERIFIED');
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'courier_account.enable' }),
      );
    });
  });

  describe('testConnection (§9.3.3, §3.21)', () => {
    it('runs a real adapter call and moves UNVERIFIED → HEALTHY', async () => {
      const result = await ctx.service.testConnection(SHOP_ID, ACCOUNT_ID);
      expect(ctx.caller.call).toHaveBeenCalledWith(
        SHOP_ID,
        ACCOUNT_ID,
        'lookupByReference',
        expect.any(Function),
      );
      expect(ctx.health.transition).toHaveBeenCalledWith(
        ACCOUNT_ID,
        SHOP_ID,
        'HEALTHY',
        expect.stringContaining('test connection'),
      );
      expect(result.healthState).toBe('UNVERIFIED'); // mocked reload returns prior row
    });
  });

  describe('ADD-18 webhook management', () => {
    it('returns the inbound URL, masked secret and health strip', async () => {
      const view = await ctx.service.getWebhookManagement(SHOP_ID, ACCOUNT_ID);
      expect(view.webhookUrl).toBe('https://api.jsyxi.test/hooks/fake/url-token-1');
      expect(view.secretSet).toBe(false); // mocked row has no secret blob
      expect(view.events24h).toBe(3);
      expect(view.signatureFailures24h).toBe(1);
    });

    it('regenerate secret: separate audited action with masked fingerprints', async () => {
      const secretBlob = ctx.vault.encrypt({ secret: 'oldsecret12345678901234567890' });
      ctx.caller.loadAccount.mockResolvedValue({
        ...ACCOUNT_ROW,
        webhook_secret_encrypted: secretBlob,
      });
      routeBySql(ctx.pool.query, [
        ['UPDATE courier_account SET webhook_secret_encrypted', () => ({ rows: [], rowCount: 1 })],
      ]);
      const result = await ctx.service.regenerateSecret(SHOP_ID, OWNER_ID, ACCOUNT_ID);
      expect(result.consequence).toContain('stops verifying immediately');
      const entry = ctx.audit.record.mock.calls[0][0];
      expect(entry.action).toBe('courier_account.webhook_secret_regenerate');
      expect(entry.before.secretFingerprint).not.toBe(entry.after.secretFingerprint);
      expect(JSON.stringify(entry)).not.toContain('oldsecret');
    });

    it('regenerate URL token: old URL stops working immediately, new URL returned', async () => {
      routeBySql(ctx.pool.query, [
        ['UPDATE courier_account SET webhook_url_token', () => ({ rows: [], rowCount: 1 })],
      ]);
      const result = await ctx.service.regenerateUrlToken(SHOP_ID, OWNER_ID, ACCOUNT_ID);
      expect(result.consequence).toContain('old webhook URL stops working immediately');
      expect(result.webhookUrl).toMatch(/^https:\/\/api\.jsyxi\.test\/hooks\/fake\//);
      expect(result.webhookUrl).not.toContain('url-token-1');
      const entry = ctx.audit.record.mock.calls[0][0];
      expect(entry.action).toBe('courier_account.webhook_url_regenerate');
      expect(JSON.stringify(entry)).not.toContain('url-token-1');
    });

    it('send test event POSTs the fake event to the account webhook path, signed', async () => {
      const secretBlob = ctx.vault.encrypt({ secret: 'hooksecret-0123456789abcdef' });
      const credsBlob = ctx.vault.encrypt({ api_token: 'testtoken123' });
      ctx.caller.loadAccount.mockResolvedValue({
        ...ACCOUNT_ROW,
        webhook_secret_encrypted: secretBlob,
        credentials_test_encrypted: credsBlob,
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      try {
        const result = await ctx.service.sendTestEvent(SHOP_ID, ACCOUNT_ID);
        expect(result).toEqual({
          delivered: true,
          status: 200,
          webhookUrl: 'https://api.jsyxi.test/hooks/fake/url-token-1',
        });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.jsyxi.test/hooks/fake/url-token-1');
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(typeof headers['x-jsyxi-signature']).toBe('string');
        // The fake event payload goes verbatim as the body.
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.awb).toMatch(/^FAKE/);
        expect(JSON.stringify(body)).not.toContain('testtoken123');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
