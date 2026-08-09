import { Module, OnModuleInit } from '@nestjs/common';
import { AdapterRegistry } from '../courier-framework/adapter-registry';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { XPRESSBEES_COURIER_CODE } from './xpressbees-api.map';
import { xpressbeesAdapterFactory } from './xpressbees.adapter';

/**
 * Xpressbees launch adapter module (§9.3.4).
 *
 * Factory registration: the framework owns the ADAPTER_FACTORIES token as a
 * single `useValue` record, so a second adapter cannot merge into it from
 * another module without either editing the framework module or a circular
 * self-injection of the same token. Instead this module registers through
 * the registry's public `AdapterRegistry.register()` — the same Map the
 * token-fed constructor populates — at module init (same pattern as the
 * Delhivery module).
 */
@Module({
  imports: [CourierFrameworkModule],
})
export class XpressbeesModule implements OnModuleInit {
  constructor(private readonly registry: AdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(XPRESSBEES_COURIER_CODE, xpressbeesAdapterFactory);
  }
}
