import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CourierAdapter } from './adapter.types';
import type { CourierAccountMode } from './vault.service';

/**
 * Adapter registry (§8.2, §9.3.4): maps courier.code → adapter factory and
 * builds one adapter instance per courier_account with its decrypted
 * credentials for the account's current mode.
 *
 * Instances are cached per (courier_account_id, mode, credentials-version):
 * a credential replace bumps courier_account.version and a mode switch
 * changes the mode, so both rebuild cleanly (RW-20) with no stale
 * credentials surviving in a cached instance (INV-18).
 *
 * The plaintext `credentials` in AdapterBuildContext is confined to this
 * build path (§5.7 control 1): factories must capture it inside the adapter
 * instance and never log or re-emit it.
 */

export interface AdapterBuildContext {
  courierAccountId: string;
  courierCode: string;
  mode: CourierAccountMode;
  /** Decrypted at call time; never logged (INV-18). */
  credentials: Record<string, string>;
  /** Injected clock — adapters stay deterministic and testable (§15.1). */
  now: () => Date;
}

export type AdapterFactory = (ctx: AdapterBuildContext) => CourierAdapter;

export const ADAPTER_FACTORIES = Symbol('ADAPTER_FACTORIES');

@Injectable()
export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly cache = new Map<string, CourierAdapter>();

  constructor(
    @Optional() @Inject(ADAPTER_FACTORIES) factories?: Record<string, AdapterFactory>,
  ) {
    for (const [code, factory] of Object.entries(factories ?? {})) {
      this.register(code, factory);
    }
  }

  register(courierCode: string, factory: AdapterFactory): void {
    this.factories.set(courierCode, factory);
  }

  has(courierCode: string): boolean {
    return this.factories.has(courierCode);
  }

  /**
   * Get (or build) the adapter for an account. `credentialsVersion` is
   * courier_account.version, bumped on every credential replace (INV-22
   * doubles as the cache-invalidation version).
   */
  getAdapter(ctx: AdapterBuildContext & { credentialsVersion: number }): CourierAdapter {
    const factory = this.factories.get(ctx.courierCode);
    if (!factory) {
      throw new Error(`no adapter registered for courier '${ctx.courierCode}'`);
    }
    const key = `${ctx.courierAccountId}:${ctx.mode}:${ctx.credentialsVersion}`;
    let adapter = this.cache.get(key);
    if (!adapter) {
      adapter = factory(ctx);
      this.cache.set(key, adapter);
    }
    return adapter;
  }

  /** Test/maintenance hook: drop all cached instances. */
  clearCache(): void {
    this.cache.clear();
  }
}
