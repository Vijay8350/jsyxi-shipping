/**
 * shipment.working_values shape — the §2.9 working set carried on a DRAFT
 * Shipment. Mutable while DRAFT / NEEDS_MANUAL_ASSIGNMENT (§10.4); frozen
 * into shipment.snapshot at the DRAFT → QUEUED transition (§2.9, INV-10).
 *
 * Additive-friendly by contract: the week-4 agent populates the weight
 * (F-24), payment-mode (§3.5) and collectible (§4.7) derivations INTO THIS
 * SAME SHAPE — extend it, never restructure it, so DRAFT rows written today
 * stay readable after those derivations land.
 */

/** RV-13 protected set — mirrors order.recipient_snapshot; null fields mean
 *  the order stays INCOMPLETE later (INV-7), never a guess (§8.1). */
export interface WorkingRecipient {
  name: string | null;
  addressLines: string[];
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
}

/** §2.9: "allocation line IDs and quantities with SKU, title, variant, tags,
 *  unit price and HSN" — plus the per-unit weight input to F-24 (RV-02). */
export interface WorkingLine {
  orderLineId: string;
  shopifyLineGid: string | null;
  sku: string | null;
  title: string | null;
  variant: string | null;
  quantity: number;
  /** NUMERIC text at the boundary (§4.1) — never a float. */
  unitPrice: string | null;
  tags: string[];
  hsnCode: string | null;
  /** Per UNIT, kg as NUMERIC text; null = no resolvable weight (§9.2.4). */
  weightKgPerUnit: string | null;
}

/** Raw gateway names are the S-14 input, stored here as working data at sync
 *  time; `mode` and `collectible` are populated by the §3.5 / F-15 derivation
 *  (order-derivation module). */
export interface WorkingPayment {
  mode: 'PREPAID' | 'COD' | 'UNRESOLVED';
  gatewayNames: string[];
  /** F-15 (§4.6), NUMERIC text; '0.00' placeholder at ingest. */
  collectible: string;
  /** Shopify total_outstanding shop money when the payload carries it — the
   *  preferred F-15 basis (§4.6). */
  totalOutstanding?: string | null;
}

/** §9.2.3 provenance: which Shopify fulfillment orders this Shipment
 *  consolidates, from which Shopify location, and via which path. */
export interface WorkingFulfillment {
  sourceFulfillmentOrderGids: string[];
  shopifyLocationGid: string | null;
  /** CONSOLIDATED = one Shipment for all in-house fulfillment orders
   *  (default, RV-11); FALLBACK_PER_FULFILLMENT_ORDER = the unmergeable
   *  fallback, the ONLY way an Order gets a second Shipment (RV-06). */
  mergePath: 'CONSOLIDATED' | 'FALLBACK_PER_FULFILLMENT_ORDER';
}

export interface ShipmentWorkingValues {
  schemaVersion: 1;
  recipient: WorkingRecipient | null;
  lines: WorkingLine[];
  payment: WorkingPayment;
  fulfillment: WorkingFulfillment;
  // Week-4 additions land here as NEW optional members (e.g. a `weight`
  // block with the F-24 per-line derivation) — see the header comment.
}
