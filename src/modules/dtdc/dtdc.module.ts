import { Module, OnModuleInit } from '@nestjs/common';
import { AdapterRegistry } from '../courier-framework/adapter-registry';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { DTDC_COURIER_CODE } from './dtdc-api.map';
import { dtdcAdapterFactory } from './dtdc.adapter';

/**
 * DTDC launch adapter module (§9.3.4).
 *
 * Factory registration mirrors the Delhivery module: the framework owns the
 * ADAPTER_FACTORIES token as a single `useValue` record, so this module
 * registers through the registry's public `AdapterRegistry.register()` —
 * the same Map the token-fed constructor populates — at module init.
 */
@Module({
  imports: [CourierFrameworkModule],
})
export class DtdcModule implements OnModuleInit {
  constructor(private readonly registry: AdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(DTDC_COURIER_CODE, dtdcAdapterFactory);
  }
}
