import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Response } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

/**
 * Process-level probes for the deployment tier (systemd, nginx, uptime checks).
 *
 * Distinct from the health module: that one is ADD-29/ADD-30 *setup* health for
 * a merchant's configuration. This is "is the process serving and are its
 * backing stores reachable" — unauthenticated by design, and deliberately
 * leaking nothing but reachability booleans.
 */
@Controller()
export class OpsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the event loop is turning. Never touches a dependency. */
  @Get('healthz')
  healthz(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** Readiness: Postgres and Redis both answer. 503 when either does not. */
  @Get('readyz')
  async readyz(@Res() res: Response): Promise<void> {
    const [database, redis] = await Promise.all([
      this.pool
        .query('SELECT 1')
        .then(() => true)
        .catch(() => false),
      this.redis
        .ping()
        .then((r) => r === 'PONG')
        .catch(() => false),
    ]);
    const ready = database && redis;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      database,
      redis,
    });
  }
}
