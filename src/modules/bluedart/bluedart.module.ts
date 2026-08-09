import { Inject, Module, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { AdapterRegistry } from '../courier-framework/adapter-registry';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { BLUEDART_COURIER_CODE } from './bluedart-api.map';
import {
  BluedartTokenCache,
  createBluedartAdapterFactory,
} from './bluedart.adapter';

/** Redis-backed JWT cache for the Blue Dart token (login endpoint → cached
 *  token with TTL, §8.2 transport policy). */
function createRedisTokenCache(redis: Redis): BluedartTokenCache {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

/**
 * Blue Dart launch adapter module (§9.3.4).
 *
 * Factory registration mirrors the Delhivery module: the framework owns the
 * ADAPTER_FACTORIES token as a single `useValue` record, so this module
 * registers through the registry's public `AdapterRegistry.register()` at
 * module init instead. The RedisModule is global, so the REDIS token is
 * injectable here without importing it.
 */
@Module({
  imports: [CourierFrameworkModule],
})
export class BluedartModule implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistry,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      BLUEDART_COURIER_CODE,
      createBluedartAdapterFactory(createRedisTokenCache(this.redis)),
    );
  }
}
