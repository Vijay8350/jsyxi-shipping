import type { InvoiceTotalsJson, TaxComponentJson } from './gst-tax';

/**
 * GST invoice types (§2.6, §3.12, §9.9.2). PG enum mirrors kept as string
 * unions, matching the booking / courier-framework convention.
 */

/** §3.12 INVOICE_STATE. VOID is terminal; ISSUED → VOID is Finance+ only. */
export type InvoiceState = 'ISSUE_PENDING' | 'ISSUED' | 'VOID';

/**
 * §9.9.2: the required-data set for issue, as stable missing-field codes.
 * Every absent required item is listed on the invoice (missing_fields jsonb),
 * surfaced as a dashboard action card and the §11 INVOICE_PENDING report
 * filter, and is fixable via PATCH /gst/invoices/:id. Issue is attempted
 * automatically once this set is empty. This list is the single definition
 * of "required" — creation, PATCH and issue all compute against it.
 */
export const MISSING_FIELD_CODES = [
  'SELLER_GSTIN', // pickup_location.gstin (§9.9.2 — the Shop's one registration)
  'SELLER_LEGAL_NAME', // seller legal name
  'SELLER_ADDRESS', // seller address lines / city / state / pincode
  'BUYER_NAME', // recipient name
  'BUYER_ADDRESS', // recipient address lines / city
  'BUYER_PINCODE', // recipient pincode
  'PLACE_OF_SUPPLY', // destination state (decides CGST+SGST vs IGST)
  'LINE_HSN', // per-line HSN code (ref carries the order line)
  'LINE_TAXABLE_VALUE', // per-line taxable value (unit price missing)
  'LINE_GST_RATE', // per-line GST rate (reserved: the 18% default fills it)
] as const;

export type MissingFieldCode = (typeof MISSING_FIELD_CODES)[number];

/** One missing_fields entry; `orderLineId` set for LINE_* codes. */
export interface MissingField {
  code: MissingFieldCode;
  orderLineId?: string;
}

/** Seller/buyer tax identity, frozen into the legal snapshot at issue (§9.9.2). */
export interface InvoicePartySnapshot {
  legalName: string | null;
  gstin: string | null; // seller only; buyers are typically unregistered (B2C)
  addressLines: string[];
  city: string | null;
  state: string | null;
  pincode: string | null;
}

/** A working line while ISSUE_PENDING; frozen into gst_invoice_line at issue. */
export interface InvoiceLineInput {
  orderLineId: string | null;
  hsnCode: string | null;
  quantity: number;
  /** Rupees per unit, 2dp string (snapshot unit price or PATCH override). */
  unitPrice: string | null;
  /** 0–1 at 6dp; null → the 18% default (§9.9.2 tax model). */
  gstRate: string | null;
}

/** The frozen line written at issue (§9.9.2 legal snapshot). */
export interface IssuedLine {
  orderLineId: string | null;
  hsnCode: string;
  quantity: number;
  taxableValue: string; // rupees 2dp
  taxComponents: TaxComponentJson[];
  lineTotal: string; // rupees 2dp
}

/** The full legal snapshot persisted on the issued invoice (§9.9.2). */
export interface InvoiceLegalSnapshot {
  seller: InvoicePartySnapshot;
  buyer: InvoicePartySnapshot;
  placeOfSupply: string;
  totals: InvoiceTotalsJson;
  currency: 'INR';
  /** Source IDs for traceability (§9.9.2 "source IDs"). */
  source: { shopId: string; orderId: string; shipmentId: string | null };
}

/** gst_invoice row shape as read from PG (jsonb already parsed). */
export interface GstInvoiceRow {
  invoice_id: string;
  shop_id: string;
  order_id: string;
  state: InvoiceState;
  series_code: string;
  invoice_number: string | null;
  financial_year: string | null;
  issued_at: string | null;
  seller_snapshot: InvoicePartySnapshot | null;
  buyer_snapshot: InvoicePartySnapshot | null;
  place_of_supply: string | null;
  totals: InvoiceTotalsJson | null;
  currency: string;
  missing_fields: MissingField[];
  void_of_invoice_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface GstInvoiceLineRow {
  invoice_line_id: string;
  invoice_id: string;
  order_line_id: string | null;
  hsn_code: string | null;
  quantity: number;
  taxable_value: string;
  tax_components: TaxComponentJson[];
  line_total: string;
}

/** Query filters for GET /gst/invoices (feeds the §11 INVOICE_PENDING report). */
export interface InvoiceListFilters {
  state?: InvoiceState;
  /** true → only invoices with a non-empty missing_fields list. */
  missingFieldsPresent?: boolean;
  /** created_at range, inclusive lower / exclusive upper (§5.2 half-open). */
  from?: string;
  to?: string;
}
