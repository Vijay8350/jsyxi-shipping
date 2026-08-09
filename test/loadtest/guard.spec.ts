import { describe, expect, it } from 'vitest';
import { assertLocalDatabaseUrl, LoadtestGuardError } from '../../scripts/loadtest/lib';

/**
 * The localhost guard is the harness's single most important safety property
 * (INV-19: fixtures are LIVE-mode, is_test = false). Every acceptance form
 * and every rejection must be pinned down.
 */
describe('assertLocalDatabaseUrl', () => {
  it.each([
    'postgres://jsyxi:pw@localhost:5432/jsyxi',
    'postgres://jsyxi:pw@127.0.0.1:5432/jsyxi',
    'postgresql://jsyxi@localhost/jsyxi',
    'postgres://jsyxi@[::1]:5432/jsyxi',
    'postgres://jsyxi@LOCALHOST:5432/jsyxi', // case-insensitive host
    'postgres:///jsyxi', // Unix-domain socket — local by definition
  ])('accepts local DSN %s', (dsn) => {
    expect(() => assertLocalDatabaseUrl(dsn)).not.toThrow();
  });

  it.each([
    'postgres://jsyxi:pw@db.internal.example.com:5432/jsyxi',
    'postgres://jsyxi:pw@192.168.1.10:5432/jsyxi',
    'postgres://jsyxi:pw@10.0.0.5/jsyxi',
    'postgres://jsyxi:pw@mydb.abc123.ap-south-1.rds.amazonaws.com:5432/jsyxi',
    'postgres://jsyxi:pw@localhost.evil.com:5432/jsyxi', // suffix spoof
  ])('rejects non-local DSN %s', (dsn) => {
    expect(() => assertLocalDatabaseUrl(dsn)).toThrow(LoadtestGuardError);
    expect(() => assertLocalDatabaseUrl(dsn)).toThrow(/non-local database host/);
  });

  it('rejects empty and unparseable URLs', () => {
    expect(() => assertLocalDatabaseUrl('')).toThrow(LoadtestGuardError);
    expect(() => assertLocalDatabaseUrl('   ')).toThrow(LoadtestGuardError);
    expect(() => assertLocalDatabaseUrl('not a url')).toThrow(LoadtestGuardError);
  });

  it('checks the host only — scheme is the caller’s concern (documented)', () => {
    // The guard's contract is the DATABASE HOST; run.ts always connects with
    // pg, so a non-pg scheme cannot reach a remote server through this path.
    expect(() => assertLocalDatabaseUrl('mysql://localhost:3306/jsyxi')).not.toThrow();
  });
});
