import { Inject, Module, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { AdapterRegistry } from '../courier-framework/adapter-registry';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { AMAZON_SHIPPING_COURIER_CODE } from './amazon_shipping-api.map';
import {
  AmazonShippingTokenCache,
  createAmazonShippingAdapterFactory,
} from './amazon_shipping.adapter';

/** Redis-backed LWA access-token cache (refresh grant → cached token with
 *  TTL, §9.3.3 OAUTH; §8.2 transport policy). */
function createRedisTokenCache(redis: Redis): AmazonShippingTokenCache {
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
 * Amazon Shipping launch adapter module (§9.3.4).
 *
 * Factory registration mirrors the Blue Dart module: the framework owns the
 * ADAPTER_FACTORIES token as a single `useValue` record, so this module
 * registers through the registry's public `AdapterRegistry.register()` at
 * module init instead. The RedisModule is global, so the REDIS token is
 * injectable here without importing it.
 */
@Module({
  imports: [CourierFrameworkModule],
})
export class AmazonShippingModule implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistry,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      AMAZON_SHIPPING_COURIER_CODE,
      createAmazonShippingAdapterFactory(createRedisTokenCache(this.redis)),
    );
  }
}
