import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AdapterCallerService } from '../courier-framework/adapter-caller.service';
import type { QuoteRequest, QuoteResponse } from '../courier-framework/adapter.types';
import type { payment_mode } from '../courier-framework/adapter.enum-types';

/** S-16 (§7.3): live-quote cache TTL, default 15 minutes. */
export const QUOTE_CACHE_TTL_MS = 15 * 60 * 1000;

interface Queryable {
  query: Pool['query'];
}

interface QuoteRow {
  quote_id: string;
  components_json: unknown;
  total: string | null;
  currency: string;
  provider_quote_ref: string | null;
  fetched_at: string;
  edd_from: string | null;
  edd_to: string | null;
  edd_source: 'PROVIDER' | 'RATE_CARD_SLA' | null;
}

/**
 * §4.5 live-quote cache: keyed on (service, origin, destination,
 * billable-weight band, payment mode) with TTL S-16; a quote older than its
 * TTL is re-fetched. Cache rows carry shipment_id = NULL — they are shared
 * pre-booking estimates, distinct from the shipment-bound quote rows the
 * booking write stores (and from the snapshot, which is the durable record).
 */
@Injectable()
export class QuoteCacheService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly adapterCaller: AdapterCallerService,
  ) {}

  private rowToQuote(row: QuoteRow): QuoteResponse {
    // components_json carries { components, rtoRule } for rows this module
    // writes (the provider's F-12 terms survive the cache); tolerate a bare
    // components array from any other writer.
    const stored = row.components_json as
      | { components?: QuoteResponse['components']; rtoRule?: QuoteResponse['rtoRule'] }
      | QuoteResponse['components'];
    const components = Array.isArray(stored) ? stored : (stored.components ?? []);
    const rtoRule = Array.isArray(stored) ? null : (stored.rtoRule ?? null);
    return {
      serviceable: true,
      failureReasons: [],
      rateAvailable: row.total !== null,
      components,
      total: row.total ?? '0.00',
      currency: 'INR',
      rtoRule,
      eddFrom: row.edd_from,
      eddTo: row.edd_to,
      eddSource: row.edd_source,
      fetchedAt: row.fetched_at,
      providerQuoteRef: row.provider_quote_ref,
      capabilityFlags: [],
    };
  }

  /** Fresh cache row for the §4.5 key, or null (stale rows are ignored). */
  async findFresh(
    db: Queryable,
    key: {
      serviceId: string;
      originPincode: string;
      destinationPincode: string;
      billableWeightBand: string | null;
      paymentMode: payment_mode;
    },
  ): Promise<QuoteResponse | null> {
    const { rows } = await db.query<QuoteRow>(
      `SELECT quote_id, components_json, total, currency, provider_quote_ref,
              fetched_at, edd_from, edd_to, edd_source
         FROM quote
        WHERE shipment_id IS NULL
          AND service_id = $1
          AND origin_pincode = $2
          AND destination_pincode = $3
          AND billable_weight_band IS NOT DISTINCT FROM $4
          AND payment_mode = $5
          AND expires_at > now()
        ORDER BY fetched_at DESC
        LIMIT 1`,
      [
        key.serviceId,
        key.originPincode,
        key.destinationPincode,
        key.billableWeightBand,
        key.paymentMode,
      ],
    );
    return rows[0] ? this.rowToQuote(rows[0]) : null;
  }

  /**
   * Fetch through the adapter (limiter → breaker → adapter, S-17 QUOTE
   * priority) and store under the §4.5 key with the S-16 TTL.
   */
  async fetchAndStore(
    db: Queryable,
    args: {
      shopId: string;
      courierAccountId: string;
      request: QuoteRequest;
      billableWeightBand: string | null;
    },
  ): Promise<QuoteResponse> {
    const quote = await this.adapterCaller.call(
      args.shopId,
      args.courierAccountId,
      'getQuote',
      (adapter) => adapter.getQuote(args.request),
    );
    // The cache row has no serviceability column — only serviceable responses
    // are cached; an unserviceable lane is re-asked next time (its coverage
    // can change, and §4.5 caches quotes, not failures).
    if (!quote.serviceable) return quote;
    await db.query(
      `INSERT INTO quote
         (shop_id, shipment_id, courier_account_id, service_id, cost_source,
          provider_quote_ref, fetched_at, expires_at, components_json, total,
          currency, edd_from, edd_to, edd_source,
          origin_pincode, destination_pincode, billable_weight_band, payment_mode)
       VALUES ($1, NULL, $2, $3, 'LIVE_QUOTE', $4, $5,
               $5::timestamptz + ($6 || ' milliseconds')::interval,
               $7, $8, 'INR', $9, $10, $11, $12, $13, $14, $15)`,
      [
        args.shopId,
        args.courierAccountId,
        args.request.serviceId,
        quote.providerQuoteRef,
        quote.fetchedAt,
        String(QUOTE_CACHE_TTL_MS),
        JSON.stringify({ components: quote.components, rtoRule: quote.rtoRule }),
        quote.rateAvailable ? quote.total : null,
        quote.eddFrom,
        quote.eddTo,
        quote.eddSource,
        args.request.originPincode,
        args.request.destinationPincode,
        args.billableWeightBand,
        args.request.paymentMode,
      ],
    );
    return quote;
  }

  /** §4.5: a fresh cached quote wins; a stale one is re-fetched. */
  async getLiveQuote(
    db: Queryable,
    args: {
      shopId: string;
      courierAccountId: string;
      request: QuoteRequest;
      billableWeightBand: string | null;
    },
  ): Promise<QuoteResponse> {
    const cached = await this.findFresh(db, {
      serviceId: args.request.serviceId,
      originPincode: args.request.originPincode,
      destinationPincode: args.request.destinationPincode,
      billableWeightBand: args.billableWeightBand,
      paymentMode: args.request.paymentMode,
    });
    if (cached) return cached;
    return this.fetchAndStore(db, args);
  }
}
