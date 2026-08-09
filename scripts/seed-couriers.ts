/**
 * §5.6 day-one courier seed: courier/service definitions with capabilities
 * and versions, and the raw→carrier-event status maps (§3.6) for every
 * launch courier (§9.3.4). Idempotent — safe to run after every deploy.
 *
 * Usage: npm run seed:couriers   (connects as the migration owner, DATABASE_URL)
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { runDelhiverySeed } from '../src/modules/delhivery/delhivery.seed';
import { runXpressbeesSeed } from '../src/modules/xpressbees/xpressbees.seed';
import { runBluedartSeed } from '../src/modules/bluedart/bluedart.seed';
import { runDtdcSeed } from '../src/modules/dtdc/dtdc.seed';
import { runAmazonShippingSeed } from '../src/modules/amazon_shipping/amazon_shipping.seed';
import { runShadowfaxSeed } from '../src/modules/shadowfax/shadowfax.seed';
import { runShiprocketSeed } from '../src/modules/shiprocket/shiprocket.seed';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runDelhiverySeed(pool);
    await runXpressbeesSeed(pool);
    await runBluedartSeed(pool);
    await runDtdcSeed(pool);
    await runAmazonShippingSeed(pool);
    await runShadowfaxSeed(pool);
    await runShiprocketSeed(pool);
    console.log('courier seeds applied (7 launch couriers, §9.3.4)');
  } finally {
    await pool.end();
  }
}

void main();
