import { Inject, Module, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { AdapterRegistry } from '../courier-framework/adapter-registry';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { SHIPROCKET_COURIER_CODE } from './shiprocket-api.map';
import {
  RedisShiprocketTokenCache,
  createShiprocketAdapterFactory,
} from './shiprocket.adapter';

/**
 * Shiprocket launch adapter module (§9.3.4) — the launch AGGREGATOR.
 *
 * Factory registration mirrors the Blue Dart module: the framework owns the
 * ADAPTER_FACTORIES token as a single `useValue` record, so this module
 * registers through the registry's public `AdapterRegistry.register()` at
 * module init instead. The RedisModule is global, so the REDIS token is
 * injectable here without importing it; it backs the login-token cache
 * (§9.3.3 token pattern).
 */
@Module({
  imports: [CourierFrameworkModule],
})
export class ShiprocketModule implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistry,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      SHIPROCKET_COURIER_CODE,
      createShiprocketAdapterFactory(new RedisShiprocketTokenCache(this.redis)),
    );
  }
}
