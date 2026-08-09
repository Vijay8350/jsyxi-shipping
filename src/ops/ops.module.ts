import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller';

/**
 * Deployment probes (/healthz, /readyz). DatabaseModule and RedisModule are
 * global, so the controller injects PG_POOL / REDIS with no imports here.
 */
@Module({ controllers: [OpsController] })
export class OpsModule {}
