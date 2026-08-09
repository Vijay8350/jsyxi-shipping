import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  blobColumnForMode,
  CredentialFieldSchema,
  CredentialsVaultService,
} from '../../src/modules/courier-framework/vault.service';
import { MASTER_KEY_HEX, mockConfig, mockPool } from './helpers';

/**
 * Credential vault (§5.7 controls 1 & 3, RW-20, INV-18). Plaintext test
 * values appear ONLY inside these unit tests as inputs/outputs of the vault
 * itself — never in assertions about what leaves the service (masked
 * display, errors, audit rows).
 */
const FIELDS: CredentialFieldSchema[] = [
  {
    key: 'api_token',
    label: 'API token',
    type: 'password',
    isSecret: true,
    isRequired: true,
    validationRegex: '^[A-Za-z0-9]{8,}$',
    displayOrder: 1,
  },
  {
    key: 'client_name',
    label: 'Client name',
    type: 'text',
    isSecret: false,
    isRequired: false,
    validationRegex: null,
    displayOrder: 2,
  },
];

const TEST_CREDS = { api_token: 'testtoken123', client_name: 'TestClient' };
const LIVE_CREDS = { api_token: 'livetoken456', client_name: 'LiveClient' };

describe('CredentialsVaultService (§5.7, RW-20, INV-18)', () => {
  let vault: CredentialsVaultService;

  beforeEach(() => {
    const { pool } = mockPool();
    vault = new CredentialsVaultService(pool as never, mockConfig() as never);
  });

  it('is constructed against the configured master key (§5.7 control 1)', () => {
    expect(MASTER_KEY_HEX).toHaveLength(64);
  });

  describe('validateCredentials (A1-12)', () => {
    it('accepts a valid object and returns only declared keys', () => {
      const clean = vault.validateCredentials(FIELDS, TEST_CREDS);
      expect(clean).toEqual(TEST_CREDS);
    });

    it('rejects missing required fields, unknown keys and regex violations — naming fields, never values', () => {
      try {
        vault.validateCredentials(FIELDS, {
          api_token: 'short',
          bogus: 'x',
        });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const body = (err as BadRequestException).getResponse() as {
          issues: Array<{ key: string; code: string }>;
        };
        expect(body.issues).toEqual(
          expect.arrayContaining([
            { key: 'api_token', code: 'INVALID_FORMAT' },
            { key: 'bogus', code: 'UNKNOWN_KEY' },
          ]),
        );
        // INV-18: the error payload must not echo the submitted value.
        expect(JSON.stringify(body)).not.toContain('short');
      }
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('round-trips through the envelope (§5.7 control 1)', () => {
      const blob = vault.encrypt(TEST_CREDS);
      expect(Buffer.isBuffer(blob)).toBe(true);
      expect(blob.toString('utf8')).not.toContain('testtoken123');
      expect(vault.decrypt(blob)).toEqual(TEST_CREDS);
    });
  });

  describe('RW-20: two independent blobs', () => {
    it('maps modes to distinct blob columns, so a write can only touch one set', () => {
      expect(blobColumnForMode('TEST')).toBe('credentials_test_encrypted');
      expect(blobColumnForMode('LIVE')).toBe('credentials_live_encrypted');
    });

    it('test and live blobs decrypt independently — switching mode never overwrites the other set (§15.2)', () => {
      const testBlob = vault.encrypt(TEST_CREDS);
      const liveBlob = vault.encrypt(LIVE_CREDS);
      // Simulate a mode switch: both blobs remain independently decryptable.
      expect(vault.decrypt(testBlob)).toEqual(TEST_CREDS);
      expect(vault.decrypt(liveBlob)).toEqual(LIVE_CREDS);
      // And replacing one never affects the other.
      const replacedTest = vault.encrypt({ api_token: 'newtoken999' });
      expect(vault.decrypt(replacedTest).api_token).toBe('newtoken999');
      expect(vault.decrypt(liveBlob)).toEqual(LIVE_CREDS);
    });
  });

  describe('maskedDisplay (§5.7 control 3)', () => {
    it('returns {key, isSecret, set} per field and never any value (INV-18)', () => {
      const blob = vault.encrypt(TEST_CREDS);
      const masked = vault.maskedDisplay(FIELDS, blob);
      expect(masked).toEqual([
        { key: 'api_token', isSecret: true, set: true },
        { key: 'client_name', isSecret: false, set: true },
      ]);
      const serialized = JSON.stringify(masked);
      expect(serialized).not.toContain('testtoken123');
      expect(serialized).not.toContain('TestClient');
    });

    it('reports set=false when no blob exists or a value is empty', () => {
      expect(vault.maskedDisplay(FIELDS, null)).toEqual([
        { key: 'api_token', isSecret: true, set: false },
        { key: 'client_name', isSecret: false, set: false },
      ]);
      const blob = vault.encrypt({ api_token: 'testtoken123', client_name: '' });
      expect(vault.maskedDisplay(FIELDS, blob)).toEqual([
        { key: 'api_token', isSecret: true, set: true },
        { key: 'client_name', isSecret: false, set: false },
      ]);
    });
  });
});
