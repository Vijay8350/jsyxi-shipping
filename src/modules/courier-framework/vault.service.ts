import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { EnvelopeCipher } from '../../common/envelope';
import { PG_POOL } from '../../database/database.module';

/**
 * Credential vault (§5.7 controls 1 & 3, RW-20, INV-18).
 *
 * - A credentials JSON object is envelope-encrypted into the TEST or LIVE blob
 *   of courier_account INDEPENDENTLY — switching mode never overwrites the
 *   other set (RW-20).
 * - Decryption happens ONLY inside the adapter-call path, at call time
 *   (§5.7 control 1). This service never returns plaintext to a controller.
 * - Credential fields are write-only with a masked display and a replace
 *   action; no role can read one back (§5.7 control 3, §10.2 deny row).
 * - Plaintext never enters logs, errors, audit rows or test assertions
 *   (INV-18): validation errors name fields and codes, never values.
 */

export type CourierAccountMode = 'TEST' | 'LIVE';

/** courier_credential_field row (global, drives the merchant form A1-12). */
export interface CredentialFieldSchema {
  key: string;
  label: string;
  type: string;
  isSecret: boolean;
  isRequired: boolean;
  validationRegex: string | null;
  displayOrder: number;
}

/** The masked display shape (§5.7 control 3): a key, whether it is secret,
 *  and whether a value is set — never the value itself. */
export interface MaskedCredentialField {
  key: string;
  isSecret: boolean;
  set: boolean;
}

export interface CredentialValidationIssue {
  key: string;
  code: 'REQUIRED' | 'UNKNOWN_KEY' | 'INVALID_FORMAT' | 'NOT_A_STRING';
}

/** The courier_account blob column for a mode. Writes MUST target exactly
 *  one of these so the other mode's set survives untouched (RW-20). */
export function blobColumnForMode(
  mode: CourierAccountMode,
): 'credentials_test_encrypted' | 'credentials_live_encrypted' {
  return mode === 'TEST' ? 'credentials_test_encrypted' : 'credentials_live_encrypted';
}

@Injectable()
export class CredentialsVaultService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  private cipher(): EnvelopeCipher {
    return EnvelopeCipher.fromHex(this.config.get<string>('crypto.masterKeyHex') ?? '');
  }

  /** The courier_credential_field schema for a courier (global data, not
   *  shop-scoped). Public shape only — this is what drives the form. */
  async fieldSchema(courierId: string): Promise<CredentialFieldSchema[]> {
    const res = await this.pool.query(
      `SELECT key, label, type, is_secret, is_required, validation_regex, display_order
         FROM courier_credential_field
        WHERE courier_id = $1
        ORDER BY display_order, key`,
      [courierId],
    );
    return res.rows.map((r) => ({
      key: r.key,
      label: r.label,
      type: r.type,
      isSecret: r.is_secret,
      isRequired: r.is_required,
      validationRegex: r.validation_regex,
      displayOrder: r.display_order,
    }));
  }

  /**
   * Validate a submitted credentials object against the field schema
   * (A1-12): required fields present, validation_regex honored, unknown keys
   * rejected. Throws BadRequestException with per-field issues — messages
   * name fields and codes only, never submitted values (INV-18).
   * Returns a clean object containing only declared keys.
   */
  validateCredentials(
    fields: CredentialFieldSchema[],
    input: Record<string, unknown>,
  ): Record<string, string> {
    const issues: CredentialValidationIssue[] = [];
    const declared = new Map(fields.map((f) => [f.key, f]));
    const clean: Record<string, string> = {};

    for (const key of Object.keys(input ?? {})) {
      if (!declared.has(key)) issues.push({ key, code: 'UNKNOWN_KEY' });
    }
    for (const field of fields) {
      const raw = input?.[field.key];
      const present = raw !== undefined && raw !== null && raw !== '';
      if (!present) {
        if (field.isRequired) issues.push({ key: field.key, code: 'REQUIRED' });
        continue;
      }
      if (typeof raw !== 'string') {
        issues.push({ key: field.key, code: 'NOT_A_STRING' });
        continue;
      }
      if (field.validationRegex && !new RegExp(field.validationRegex).test(raw)) {
        issues.push({ key: field.key, code: 'INVALID_FORMAT' });
        continue;
      }
      clean[field.key] = raw;
    }
    if (issues.length > 0) {
      throw new BadRequestException({
        message: 'credential validation failed',
        issues,
      });
    }
    return clean;
  }

  /** §5.7 control 1: envelope-encrypt a validated credentials object. */
  encrypt(credentials: Record<string, string>): Buffer {
    return this.cipher().encrypt(JSON.stringify(credentials));
  }

  /**
   * §5.7 control 1 / INV-18: decrypt a blob. This is the ONLY plaintext exit
   * and is called exclusively from the adapter-call path at call time.
   * Controllers must use maskedDisplay() instead.
   */
  decrypt(blob: Buffer): Record<string, string> {
    return JSON.parse(this.cipher().decrypt(blob).toString('utf8')) as Record<string, string>;
  }

  /**
   * Masked display (§5.7 control 3): the form re-render after connect or
   * replace. Returns {key, isSecret, set} per declared field — values are
   * never returned for any role, including Owner (§10.2 deny row).
   * The blob is decrypted in-memory only to learn WHICH keys are set.
   */
  maskedDisplay(
    fields: CredentialFieldSchema[],
    blob: Buffer | null,
  ): MaskedCredentialField[] {
    let setKeys = new Set<string>();
    if (blob) {
      const parsed = this.decrypt(blob);
      setKeys = new Set(
        Object.entries(parsed)
          .filter(([, v]) => typeof v === 'string' && v.length > 0)
          .map(([k]) => k),
      );
    }
    return fields.map((f) => ({ key: f.key, isSecret: f.isSecret, set: setKeys.has(f.key) }));
  }
}
