import { Injectable, Logger } from '@nestjs/common';
import { MappedOrder, mapShopifyOrder } from './order-mapper';
import { OrderUpsertResult, OrderUpsertService } from './order-upsert.service';
import { AllocationService } from './allocation.service';
import { ShopifyRestOrderPayload } from './shopify-order-payload.types';
import { OrderDerivationService } from '../order-derivation/order-derivation.service';
import { CodConfirmationService } from '../notifications/cod-confirmation.service';

/**
 * §9.2.1 ingestion pipeline, shared by the orders/* webhook handlers and
 * the hourly sweep (S-15): map (§8.1) → upsert (INV-22) → rebuild
 * allocations + DRAFT shipments while unbooked (§9.2.3/§9.2.5).
 *
 * INV-7 eligibility (READY/INCOMPLETE) and §3.5 payment mode are computed by
 * the order-derivation module, invoked here after the allocation rebuild so
 * the DRAFT shipments exist for its working-values writes.
 */
export interface OrderIngestResult {
  mapped: MappedOrder;
  upsert: OrderUpsertResult;
  allocationsRebuilt: boolean;
}

@Injectable()
export class OrderIngestService {
  private readonly logger = new Logger(OrderIngestService.name);

  constructor(
    private readonly upserts: OrderUpsertService,
    private readonly allocations: AllocationService,
    private readonly derivation: OrderDerivationService,
    private readonly codConfirmation: CodConfirmationService,
  ) {}

  async ingest(shopId: string, payload: ShopifyRestOrderPayload): Promise<OrderIngestResult> {
    const mapped = mapShopifyOrder(payload);
    const upsert = await this.upserts.upsert(shopId, mapped);
    let allocationsRebuilt = false;
    if (upsert.unbooked) {
      const { rebuilt } = await this.allocations.rebuild(shopId, upsert.orderId, mapped);
      allocationsRebuilt = rebuilt;
      // Week-4 derivations: F-24/F-20, §3.5 payment mode, F-15, INV-7
      // eligibility and the §3.24 cod_assignment_state (§9.2.1/§9.2.2).
      await this.derivation.evaluateAfterUpsert(upsert);
      // ADD-28: a COD order may need buyer confirmation before booking
      // (self-guarding: no-ops unless the flow is on and the order is COD).
      await this.codConfirmation.start(shopId, upsert.orderId);
    }
    // §5.7 control 4: order IDs only — never recipient data.
    this.logger.log(
      `order ingested shop=${shopId} order=${upsert.orderId} gid=${mapped.shopifyOrderGid} ` +
        `inserted=${upsert.inserted} linesRewritten=${upsert.linesRewritten} ` +
        `allocationsRebuilt=${allocationsRebuilt}`,
    );
    return { mapped, upsert, allocationsRebuilt };
  }
}
