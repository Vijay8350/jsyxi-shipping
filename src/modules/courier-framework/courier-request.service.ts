import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

/**
 * Request a courier (§9.3.5): a button that increments a demand counter
 * (`courier_request`) visible in the admin panel. Global-scope table with
 * shop_id recorded for provenance (INV-1).
 */
@Injectable()
export class CourierRequestService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async request(shopId: string, courierNameText: string): Promise<{ recorded: true }> {
    await this.pool.query(
      `INSERT INTO courier_request (shop_id, courier_name_text) VALUES ($1, $2)`,
      [shopId, courierNameText.trim()],
    );
    return { recorded: true };
  }
}
