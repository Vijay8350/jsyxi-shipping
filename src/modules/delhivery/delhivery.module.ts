import { Module, OnModuleInit } from '@nestjs/common';
import { AdapterRegistry } from '../courier-framework/adapter-registry';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { DELHIVERY_COURIER_CODE } from './delhivery-api.map';
import { delhiveryAdapterFactory } from './delhivery.adapter';

/**
 * Delhivery launch adapter module (§9.3.4).
 *
 * Factory registration: the framework owns the ADAPTER_FACTORIES token as a
 * single `useValue` record, so a second adapter cannot merge into it from
 * another module without either editing the framework module or a circular
 * self-injection of the same token. Instead this module registers through
 * the registry's public `AdapterRegistry.register()` — the same Map the
 * token-fed constructor populates — at module init.
 *
 * PROPOSAL (framework change, not made here): when a third adapter lands,
 * turn ADAPTER_FACTORIES into a merged provider (e.g. per-module
 * ADAPTER_FACTORY_ENTRIES tokens collected via a multi-provider or a small
 * registry-options token), so registration is declarative again.
 */
@Module({
  imports: [CourierFrameworkModule],
})
export class DelhiveryModule implements OnModuleInit {
  constructor(private readonly registry: AdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(DELHIVERY_COURIER_CODE, delhiveryAdapterFactory);
  }
}
