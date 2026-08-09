import { Module, OnModuleInit } from '@nestjs/common';
import { AdapterRegistry } from '../courier-framework/adapter-registry';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { SHADOWFAX_COURIER_CODE } from './shadowfax-api.map';
import { shadowfaxAdapterFactory } from './shadowfax.adapter';

/**
 * Shadowfax launch adapter module (§9.3.4).
 *
 * Factory registration: the framework owns the ADAPTER_FACTORIES token as a
 * single `useValue` record, so an adapter cannot merge into it from another
 * module without either editing the framework module or a circular
 * self-injection of the same token. Instead this module registers through
 * the registry's public `AdapterRegistry.register()` — the same Map the
 * token-fed constructor populates — at module init (same pattern as the
 * Delhivery module).
 *
 * Auth is KEY_PASTE (§9.3.3): one static api_key, no token exchange — so,
 * unlike the Xpressbees/Blue Dart modules, this factory needs no Redis
 * handle.
 */
@Module({
  imports: [CourierFrameworkModule],
})
export class ShadowfaxModule implements OnModuleInit {
  constructor(private readonly registry: AdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(SHADOWFAX_COURIER_CODE, shadowfaxAdapterFactory);
  }
}
