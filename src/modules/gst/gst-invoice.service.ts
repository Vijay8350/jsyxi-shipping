import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { rateToMillionths, rupeesToPaise, paiseToRupees } from '../../common/money';
import { PG_POOL } from '../../database/database.module';
import type { BookingSnapshot } from '../booking/booking.types';
import {
  computeLineTax,
  computeTotals,
  DEFAULT_GST_RATE,
  financialYearAt,
  formatInvoiceNumber,
  lineTotalPaise,
  millionthsToRateString,
  taxComponentsJson,
  taxableValuePaise,
  type InvoiceTotalsJson,
  type LineTaxPaise,
  type TaxComponentJson,
} from './gst-tax';
import type {
  GstInvoiceLineRow,
  GstInvoiceRow,
  InvoiceListFilters,
  InvoiceLineInput,
  InvoicePartySnapshot,
  MissingField,
} from './gst.types';

/**
 * GST invoice service (§9.9.2, §3.12).
 *
 *  - One gst_invoice per Order, created at the first non-test CONFIRMED
 *    outbound booking in ISSUE_PENDING and reused across sibling Shipments
 *    (ON CONFLICT (shop_id, order_id) DO NOTHING). Booking never blocks on
 *    invoice data (A2-07, INV-7); a test Shipment never creates or
 *    contributes to an invoice (INV-19) — onShipmentConfirmed no-ops for it.
 *  - Issue is attempted automatically once the required data is present
 *    (§9.9.2). The number is allocated ONLY at successful issue (INV-13):
 *    allocation and the ISSUED transition happen in ONE transaction, so a
 *    mid-issue failure rolls the number back and incomplete data never
 *    produces a sequence gap. Gaps arise only from VOID.
 *  - While ISSUE_PENDING the invoice and its lines are working values and may
 *    be patched; at ISSUED the legal snapshot is frozen and the row becomes
 *    immutable (§5.3). Corrections are NEW LINKED records
 *    (void_of_invoice_id), never edits (INV-16).
 *  - Logs and audit entries carry ids / states / numbers only — the
 *    seller/buyer snapshots contain tax identity and are never logged
 *    (§5.7, INV-18).
 */

export interface ShipmentInvoiceRow {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  booking_state: string;
  is_test: boolean;
  snapshot: BookingSnapshot | null;
}

export interface IssueResult {
  issued: boolean;
  invoiceId: string;
  reason?: 'MISSING_FIELDS' | 'ALREADY_ISSUED' | 'ALREADY_VOID';
  invoiceNumber?: string;
  financialYear?: string;
}

interface Actor {
  kind: 'MEMBER' | 'SYSTEM';
  id: string | null;
}

const SYSTEM: Actor = { kind: 'SYSTEM', id: null };

/** Empty party snapshot — fields filled from the booking snapshot or PATCH. */
function emptyParty(): InvoicePartySnapshot {
  return { legalName: null, gstin: null, addressLines: [], city: null, state: null, pincode: null };
}

function blank(s: string | null | undefined): boolean {
  return !s || s.trim() === '';
}

/**
 * The §9.9.2 required-data check — the single place "required" is defined
 * (creation, PATCH and issue all compute against this). Each absent item
 * becomes a stable MissingField code, listed on the invoice and surfaced to
 * the dashboard card / §11 INVOICE_PENDING report.
 */
export function computeMissingFields(args: {
  seller: InvoicePartySnapshot;
  buyer: InvoicePartySnapshot;
  placeOfSupply: string | null;
  lines: InvoiceLineInput[];
}): MissingField[] {
  const { seller, buyer, placeOfSupply, lines } = args;
  const missing: MissingField[] = [];
  if (blank(seller.gstin)) missing.push({ code: 'SELLER_GSTIN' });
  if (blank(seller.legalName)) missing.push({ code: 'SELLER_LEGAL_NAME' });
  if (
    seller.addressLines.length === 0 ||
    blank(seller.city) ||
    blank(seller.state) ||
    blank(seller.pincode)
  ) {
    missing.push({ code: 'SELLER_ADDRESS' });
  }
  if (blank(buyer.legalName)) missing.push({ code: 'BUYER_NAME' });
  if (buyer.addressLines.length === 0 || blank(buyer.city)) missing.push({ code: 'BUYER_ADDRESS' });
  if (blank(buyer.pincode)) missing.push({ code: 'BUYER_PINCODE' });
  if (blank(placeOfSupply)) missing.push({ code: 'PLACE_OF_SUPPLY' });
  for (const line of lines) {
    if (blank(line.hsnCode)) {
      missing.push({ code: 'LINE_HSN', orderLineId: line.orderLineId ?? undefined });
    }
    if (line.unitPrice === null) {
      missing.push({ code: 'LINE_TAXABLE_VALUE', orderLineId: line.orderLineId ?? undefined });
    }
    // LINE_GST_RATE is never emitted at v1: the 18% default (DEFAULT_GST_RATE)
    // always fills an unset rate (§9.9.2 tax model).
  }
  return missing;
}

/**
 * Full per-line rate from stored components: CGST+SGST halves sum to the
 * full rate, IGST alone is the full rate. Empty (zero-tax) → the default.
 */
function rateFromComponents(components: TaxComponentJson[]): bigint {
  if (components.length === 0) return DEFAULT_GST_RATE;
  return components.reduce((acc, c) => acc + rateToMillionths(c.rate), 0n);
}

/** Components for storage; zero-tax lines still record the rate so PATCH
 *  round-trips it. */
function componentsForStorage(tax: LineTaxPaise, rate: bigint, intraState: boolean): TaxComponentJson[] {
  const json = taxComponentsJson(tax, rate);
  if (json.length > 0) return json;
  const half = rate / 2n;
  return intraState
    ? [
        { type: 'CGST', rate: millionthsToRateString(half), amount: '0.00' },
        { type: 'SGST', rate: millionthsToRateString(rate - half), amount: '0.00' },
      ]
    : [{ type: 'IGST', rate: millionthsToRateString(rate), amount: '0.00' }];
}

@Injectable()
export class GstInvoiceService {
  private readonly logger = new Logger(GstInvoiceService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------------------------------------------------
   * §9.9.2 creation seam — called by the booking worker on CONFIRMED.
   * --------------------------------------------------------------------- */

  /**
   * First non-test CONFIRMED outbound booking creates the Order's invoice in
   * ISSUE_PENDING; siblings reuse it (A1-08/A3-02). Never throws into the
   * booking path's invariants: booking never blocks on invoice data (INV-7).
   * INV-19: a test shipment is a hard no-op.
   */
  async onShipmentConfirmed(shopId: string, shipmentId: string): Promise<void> {
    const { rows } = await this.pool.query<ShipmentInvoiceRow>(
      `SELECT shipment_id, shop_id, order_id, booking_state, is_test, snapshot
         FROM shipment
        WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, shipmentId],
    );
    const shipment = rows[0];
    if (!shipment || shipment.is_test || shipment.booking_state !== 'CONFIRMED') {
      return; // INV-19 / not a confirmation — nothing to do
    }

    const draft = this.draftFromSnapshot(shipment);
    const missing = computeMissingFields(draft);

    // §9.9.2: reused across sibling Shipments — exactly one row per Order.
    const { rows: inserted } = await this.pool.query<{ invoice_id: string }>(
      `INSERT INTO gst_invoice
         (shop_id, order_id, seller_snapshot, buyer_snapshot, place_of_supply, missing_fields)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (shop_id, order_id) DO NOTHING
       RETURNING invoice_id`,
      [
        shopId,
        shipment.order_id,
        JSON.stringify(draft.seller),
        JSON.stringify(draft.buyer),
        draft.placeOfSupply,
        JSON.stringify(missing),
      ],
    );

    let invoiceId: string;
    if (inserted[0]) {
      invoiceId = inserted[0].invoice_id;
      await this.insertLines(invoiceId, draft);
      await this.audit.record({
        shopId,
        actorKind: 'SYSTEM',
        action: 'gst_invoice.created', // §12
        objectType: 'gst_invoice',
        objectId: invoiceId,
        after: { state: 'ISSUE_PENDING', orderId: shipment.order_id, shipmentId },
      });
    } else {
      // Sibling confirmation — the invoice already exists; re-attempt issue
      // (idempotent: no-op unless ISSUE_PENDING with complete data).
      const { rows: existing } = await this.pool.query<{ invoice_id: string }>(
        `SELECT invoice_id FROM gst_invoice WHERE shop_id = $1 AND order_id = $2`,
        [shopId, shipment.order_id],
      );
      if (!existing[0]) return;
      invoiceId = existing[0].invoice_id;
    }

    const result = await this.attemptIssue(shopId, invoiceId, SYSTEM);
    if (!result.issued && result.reason === 'MISSING_FIELDS') {
      // Ids only — never the snapshot contents (§5.7 control 4).
      this.logger.log(`invoice=${invoiceId} ISSUE_PENDING: required data missing`);
    }
  }

  /** §9.9.2: seller/buyer identity from the FROZEN booking snapshot (§2.9). */
  private draftFromSnapshot(shipment: ShipmentInvoiceRow): {
    seller: InvoicePartySnapshot;
    buyer: InvoicePartySnapshot;
    placeOfSupply: string | null;
    lines: InvoiceLineInput[];
  } {
    const snap = shipment.snapshot;
    const seller = emptyParty();
    if (snap?.pickupLocation) {
      seller.legalName = snap.pickupLocation.name ?? null;
      seller.gstin = snap.pickupLocation.gstin ?? null;
      seller.addressLines = snap.pickupLocation.addressLines ?? [];
      seller.city = snap.pickupLocation.city ?? null;
      seller.state = snap.pickupLocation.state ?? null;
      seller.pincode = snap.pickupLocation.pincode ?? null;
    }
    const buyer = emptyParty();
    if (snap?.recipient) {
      buyer.legalName = snap.recipient.name ?? null;
      buyer.addressLines = snap.recipient.addressLines ?? [];
      buyer.city = snap.recipient.city ?? null;
      buyer.state = snap.recipient.state ?? null;
      buyer.pincode = snap.recipient.pincode ?? null;
    }
    return {
      seller,
      buyer,
      // §9.9.2: place of supply is the destination state.
      placeOfSupply: snap?.recipient?.state ?? null,
      lines: (snap?.lines ?? []).map((l) => ({
        orderLineId: l.orderLineId,
        hsnCode: l.hsnCode ?? null,
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? null,
        gstRate: null, // 18% default until a PATCH overrides (§9.9.2 tax model)
      })),
    };
  }

  /** Working lines at creation; frozen by the ISSUED transition (§5.3). */
  private async insertLines(
    invoiceId: string,
    draft: {
      seller: InvoicePartySnapshot;
      placeOfSupply: string | null;
      lines: InvoiceLineInput[];
    },
  ): Promise<void> {
    const intraState =
      !blank(draft.seller.state) &&
      !blank(draft.placeOfSupply) &&
      draft.seller.state === draft.placeOfSupply;
    for (const line of draft.lines) {
      const rate = line.gstRate ? rateToMillionths(line.gstRate) : DEFAULT_GST_RATE;
      const taxable = taxableValuePaise(line.unitPrice, line.quantity) ?? 0n;
      const tax = computeLineTax(taxable, rate, intraState);
      await this.pool.query(
        `INSERT INTO gst_invoice_line
           (invoice_id, order_line_id, hsn_code, quantity, taxable_value, tax_components, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          invoiceId,
          line.orderLineId,
          line.hsnCode,
          line.quantity,
          paiseToRupees(taxable),
          JSON.stringify(componentsForStorage(tax, rate, intraState)),
          paiseToRupees(lineTotalPaise(taxable, tax)),
        ],
      );
    }
  }

  /* ------------------------------------------------------------------------
   * §3.12 / INV-13 issue — one transaction, number allocated only on success.
   * --------------------------------------------------------------------- */

  /**
   * Attempt ISSUE_PENDING → ISSUED. Idempotent: any other state is a no-op.
   * The sequence allocation, the frozen totals and the state transition are
   * ONE transaction — a mid-issue failure rolls back the allocation, so a
   * failed issue leaves NO number allocated and no sequence gap (INV-13).
   */
  async attemptIssue(shopId: string, invoiceId: string, actor: Actor): Promise<IssueResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<GstInvoiceRow>(
        `SELECT * FROM gst_invoice
          WHERE shop_id = $1 AND invoice_id = $2
          FOR UPDATE`,
        [shopId, invoiceId],
      );
      const invoice = rows[0];
      if (!invoice) {
        await client.query('ROLLBACK');
        throw new NotFoundException('gst invoice not found');
      }
      if (invoice.state === 'ISSUED') {
        await client.query('COMMIT');
        return { issued: false, invoiceId, reason: 'ALREADY_ISSUED' };
      }
      if (invoice.state === 'VOID') {
        await client.query('COMMIT');
        return { issued: false, invoiceId, reason: 'ALREADY_VOID' };
      }
      const missing = invoice.missing_fields ?? [];
      if (missing.length > 0) {
        // §3.12: incomplete data allocates no number — no sequence gap.
        await client.query('COMMIT');
        return { issued: false, invoiceId, reason: 'MISSING_FIELDS' };
      }

      const seller = invoice.seller_snapshot;
      const gstin = seller?.gstin;
      if (!gstin) {
        // Defensive: SELLER_GSTIN is in the required set, so this is
        // unreachable through computeMissingFields — fail loudly, no number.
        await client.query('ROLLBACK');
        throw new Error(`invoice ${invoiceId} complete but seller GSTIN absent`);
      }

      const { rows: lines } = await client.query<GstInvoiceLineRow>(
        `SELECT * FROM gst_invoice_line WHERE invoice_id = $1 ORDER BY created_at, invoice_line_id`,
        [invoiceId],
      );
      const totals = this.totalsFromLines(lines);

      // §5.2 / A1-11: the financial year of the issued-at instant, shop-local.
      const { rows: tzRows } = await client.query<{ timezone: string }>(
        `SELECT COALESCE(ss.timezone, s.iana_timezone) AS timezone
           FROM shop s LEFT JOIN store_settings ss ON ss.shop_id = s.shop_id
          WHERE s.shop_id = $1`,
        [shopId],
      );
      const timezone = tzRows[0]?.timezone ?? 'Asia/Kolkata';
      const financialYear = financialYearAt(new Date(), timezone);

      // INV-13: the single atomic allocation point per
      // (shop, gstin, financial year, series). The returned value IS the
      // sequence number to use; the statement is the only writer.
      const { rows: seqRows } = await client.query<{ next_number: number }>(
        `INSERT INTO invoice_number_sequence
           (shop_id, gstin, financial_year, series_code, next_number)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (shop_id, gstin, financial_year, series_code)
         DO UPDATE SET next_number = invoice_number_sequence.next_number + 1
         RETURNING next_number`,
        [shopId, gstin, financialYear, invoice.series_code],
      );
      const seq = seqRows[0].next_number;
      const invoiceNumber = formatInvoiceNumber(invoice.series_code, financialYear, seq); // §13.5

      await client.query(
        `UPDATE gst_invoice
            SET state = 'ISSUED',
                invoice_number = $3,
                financial_year = $4,
                issued_at = now(),
                totals = $5,
                version = version + 1
          WHERE shop_id = $1 AND invoice_id = $2 AND state = 'ISSUE_PENDING'`,
        [shopId, invoiceId, invoiceNumber, financialYear, JSON.stringify(totals)],
      );
      await client.query('COMMIT');

      await this.audit.record({
        shopId,
        actorKind: actor.kind,
        actorId: actor.id,
        action: 'gst_invoice.issued', // §12
        objectType: 'gst_invoice',
        objectId: invoiceId,
        before: { state: 'ISSUE_PENDING' },
        after: { state: 'ISSUED', invoiceNumber, financialYear },
      });
      return { issued: true, invoiceId, invoiceNumber, financialYear };
    } catch (err) {
      // Rollback releases the allocated number too — no gap from failure.
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Totals as sums of the stored rounded per-line components (INV-15). */
  private totalsFromLines(lines: GstInvoiceLineRow[]): InvoiceTotalsJson {
    return computeTotals(
      lines.map((l) => {
        const tax: LineTaxPaise = { cgst: 0n, sgst: 0n, igst: 0n };
        for (const c of l.tax_components ?? []) {
          const paise = rupeesToPaise(c.amount);
          if (c.type === 'CGST') tax.cgst += paise;
          else if (c.type === 'SGST') tax.sgst += paise;
          else tax.igst += paise;
        }
        return { taxableValue: rupeesToPaise(l.taxable_value), tax };
      }),
    );
  }

  /* ------------------------------------------------------------------------
   * PATCH — supply missing fields (§9.9.2); re-attempts issue automatically.
   * --------------------------------------------------------------------- */

  async patchInvoice(
    shopId: string,
    invoiceId: string,
    memberId: string,
    patch: {
      version: number;
      seller?: Partial<InvoicePartySnapshot>;
      buyer?: Partial<InvoicePartySnapshot>;
      placeOfSupply?: string;
      lines?: Array<{
        orderLineId: string;
        hsnCode?: string;
        unitPrice?: string;
        gstRate?: string;
      }>;
    },
  ): Promise<{ invoice: GstInvoiceRow; lines: GstInvoiceLineRow[]; issue: IssueResult | null }> {
    const client = await this.pool.connect();
    let missing: MissingField[];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<GstInvoiceRow>(
        `SELECT * FROM gst_invoice WHERE shop_id = $1 AND invoice_id = $2 FOR UPDATE`,
        [shopId, invoiceId],
      );
      const invoice = rows[0];
      if (!invoice) {
        await client.query('ROLLBACK');
        throw new NotFoundException('gst invoice not found');
      }
      // §5.3: immutable once issued — corrections are linked records (INV-16).
      if (invoice.state !== 'ISSUE_PENDING') {
        await client.query('ROLLBACK');
        throw new ConflictException(`invoice is ${invoice.state}; only ISSUE_PENDING is editable`);
      }

      const seller = { ...emptyParty(), ...(invoice.seller_snapshot ?? {}), ...(patch.seller ?? {}) };
      const buyer = { ...emptyParty(), ...(invoice.buyer_snapshot ?? {}), ...(patch.buyer ?? {}) };
      const placeOfSupply = patch.placeOfSupply ?? invoice.place_of_supply;

      const { rows: lineRows } = await client.query<GstInvoiceLineRow>(
        `SELECT * FROM gst_invoice_line WHERE invoice_id = $1`,
        [invoiceId],
      );
      const intraState =
        !blank(seller.state) && !blank(placeOfSupply) && seller.state === placeOfSupply;

      for (const lp of patch.lines ?? []) {
        const current = lineRows.find((l) => l.order_line_id === lp.orderLineId);
        if (!current) {
          await client.query('ROLLBACK');
          throw new BadRequestException(`unknown order line ${lp.orderLineId}`);
        }
        const rate = lp.gstRate
          ? rateToMillionths(lp.gstRate)
          : rateFromComponents(current.tax_components ?? []);
        const unitPrice = lp.unitPrice ?? null;
        const hsnCode = lp.hsnCode ?? current.hsn_code;
        // A line PATCH only overrides the fields it carries.
        const taxable =
          lp.unitPrice !== undefined
            ? (taxableValuePaise(unitPrice, current.quantity) ?? 0n)
            : rupeesToPaise(current.taxable_value);
        const tax = computeLineTax(taxable, rate, intraState);
        await client.query(
          `UPDATE gst_invoice_line
              SET hsn_code = $3, taxable_value = $4, tax_components = $5, line_total = $6
            WHERE invoice_id = $1 AND order_line_id = $2`,
          [
            invoiceId,
            lp.orderLineId,
            hsnCode,
            paiseToRupees(taxable),
            JSON.stringify(componentsForStorage(tax, rate, intraState)),
            paiseToRupees(lineTotalPaise(taxable, tax)),
          ],
        );
      }

      // Recompute missing_fields against the merged state (§9.9.2). A price
      // never supplied stays missing: the stored taxable '0.00' must not
      // silently clear LINE_TAXABLE_VALUE unless this PATCH supplied a price.
      const previouslyMissingPrice = new Set(
        (invoice.missing_fields ?? [])
          .filter((m) => m.code === 'LINE_TAXABLE_VALUE')
          .map((m) => m.orderLineId),
      );
      const patchedPrice = new Set(
        (patch.lines ?? [])
          .filter((l) => l.unitPrice !== undefined)
          .map((l) => l.orderLineId),
      );
      const { rows: mergedLines } = await client.query<GstInvoiceLineRow>(
        `SELECT * FROM gst_invoice_line WHERE invoice_id = $1`,
        [invoiceId],
      );
      missing = computeMissingFields({
        seller,
        buyer,
        placeOfSupply,
        lines: mergedLines.map((l) => ({
          orderLineId: l.order_line_id,
          hsnCode: l.hsn_code,
          quantity: l.quantity,
          unitPrice:
            previouslyMissingPrice.has(l.order_line_id ?? '') &&
            !patchedPrice.has(l.order_line_id ?? '')
              ? null
              : l.taxable_value,
          gstRate: null,
        })),
      });

      // INV-22: the writer carries the version it read; mismatch rejects.
      const { rowCount } = await client.query(
        `UPDATE gst_invoice
            SET seller_snapshot = $3, buyer_snapshot = $4, place_of_supply = $5,
                missing_fields = $6, version = version + 1
          WHERE shop_id = $1 AND invoice_id = $2 AND version = $7`,
        [
          shopId,
          invoiceId,
          JSON.stringify(seller),
          JSON.stringify(buyer),
          placeOfSupply,
          JSON.stringify(missing),
          patch.version,
        ],
      );
      if (rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new ConflictException('version conflict; refresh and reapply'); // INV-22
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'gst_invoice.fields_supplied', // §12 — codes only, no identity
      objectType: 'gst_invoice',
      objectId: invoiceId,
      after: { missingFields: missing.map((m) => m.code) },
    });

    // §9.9.2: issue is attempted automatically once required data is present.
    const issue = missing.length === 0 ? await this.attemptIssue(shopId, invoiceId, { kind: 'MEMBER', id: memberId }) : null;
    const detail = await this.getInvoice(shopId, invoiceId);
    return { ...detail, issue };
  }

  /* ------------------------------------------------------------------------
   * §3.12 void + §9.9.2 / INV-16 linked corrections.
   * --------------------------------------------------------------------- */

  /** ISSUED → VOID (terminal), Finance+ with a mandatory reason, audited. */
  async voidInvoice(
    shopId: string,
    invoiceId: string,
    memberId: string,
    reason: string,
  ): Promise<GstInvoiceRow> {
    if (blank(reason)) throw new BadRequestException('a void reason is mandatory'); // §3.12
    const client = await this.pool.connect();
    let before: GstInvoiceRow;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<GstInvoiceRow>(
        `SELECT * FROM gst_invoice WHERE shop_id = $1 AND invoice_id = $2 FOR UPDATE`,
        [shopId, invoiceId],
      );
      const invoice = rows[0];
      if (!invoice) {
        await client.query('ROLLBACK');
        throw new NotFoundException('gst invoice not found');
      }
      // §3.12: ISSUED is terminal except this one transition; VOID is terminal.
      if (invoice.state !== 'ISSUED') {
        await client.query('ROLLBACK');
        throw new ConflictException(`invoice is ${invoice.state}; only ISSUED can be voided`);
      }
      before = invoice;
      // The number is kept on the voided row: the sequence gap is retained
      // (INV-13) and the row stays append-only evidence (§5.3).
      await client.query(
        `UPDATE gst_invoice SET state = 'VOID', version = version + 1
          WHERE shop_id = $1 AND invoice_id = $2 AND state = 'ISSUED'`,
        [shopId, invoiceId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'gst_invoice.voided', // §12, §3.12 — reason is mandatory
      objectType: 'gst_invoice',
      objectId: invoiceId,
      before: { state: 'ISSUED', invoiceNumber: before.invoice_number },
      after: { state: 'VOID' },
      reason,
    });
    const { invoice } = await this.getInvoice(shopId, invoiceId);
    return invoice;
  }

  /**
   * INV-16: a correction is a NEW LINKED record, never an edit. Creates a
   * credit note in ISSUE_PENDING against the VOIDED original
   * (void_of_invoice_id), copies the frozen snapshot forward, and — per
   * §9.9.2 — attempts issue automatically since the data is complete.
   */
  async createCreditNote(
    shopId: string,
    invoiceId: string,
    memberId: string,
    reason?: string,
  ): Promise<{ invoice: GstInvoiceRow; lines: GstInvoiceLineRow[]; issue: IssueResult | null }> {
    const client = await this.pool.connect();
    let creditNoteId: string;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<GstInvoiceRow>(
        `SELECT * FROM gst_invoice WHERE shop_id = $1 AND invoice_id = $2 FOR UPDATE`,
        [shopId, invoiceId],
      );
      const original = rows[0];
      if (!original) {
        await client.query('ROLLBACK');
        throw new NotFoundException('gst invoice not found');
      }
      if (original.state !== 'VOID') {
        await client.query('ROLLBACK');
        throw new ConflictException('a credit note requires a VOID original');
      }
      const { rows: inserted } = await client.query<{ invoice_id: string }>(
        `INSERT INTO gst_invoice
           (shop_id, order_id, series_code, seller_snapshot, buyer_snapshot,
            place_of_supply, missing_fields, void_of_invoice_id)
         VALUES ($1, $2, 'CN', $3, $4, $5, '[]', $6)
         RETURNING invoice_id`,
        [
          shopId,
          original.order_id,
          JSON.stringify(original.seller_snapshot),
          JSON.stringify(original.buyer_snapshot),
          original.place_of_supply,
          invoiceId,
        ],
      );
      creditNoteId = inserted[0].invoice_id;
      await client.query(
        `INSERT INTO gst_invoice_line
           (invoice_id, order_line_id, hsn_code, quantity, taxable_value, tax_components, line_total)
         SELECT $2, order_line_id, hsn_code, quantity, taxable_value, tax_components, line_total
           FROM gst_invoice_line WHERE invoice_id = $1`,
        [invoiceId, creditNoteId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'gst_invoice.credit_note_created', // §12, INV-16
      objectType: 'gst_invoice',
      objectId: creditNoteId,
      after: { voidOfInvoiceId: invoiceId, seriesCode: 'CN' },
      reason: reason ?? null,
    });
    const issue = await this.attemptIssue(shopId, creditNoteId, { kind: 'MEMBER', id: memberId });
    const detail = await this.getInvoice(shopId, creditNoteId);
    return { ...detail, issue };
  }

  /* ------------------------------------------------------------------------
   * Queries — feed the dashboard card (§9.10) and §11 INVOICE_PENDING report.
   * --------------------------------------------------------------------- */

  /** GET /gst/invoices — state / missing-fields / created-at range filters. */
  async listInvoices(
    shopId: string,
    filters: InvoiceListFilters,
  ): Promise<GstInvoiceRow[]> {
    const where: string[] = ['shop_id = $1'];
    const params: unknown[] = [shopId];
    if (filters.state) {
      params.push(filters.state);
      where.push(`state = $${params.length}`);
    }
    if (filters.missingFieldsPresent) {
      where.push(`jsonb_array_length(missing_fields) > 0`);
    }
    // §5.2: half-open [from, to) on created_at.
    if (filters.from) {
      params.push(filters.from);
      where.push(`created_at >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`created_at < $${params.length}`);
    }
    const { rows } = await this.pool.query<GstInvoiceRow>(
      `SELECT * FROM gst_invoice
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, invoice_id`,
      params,
    );
    return rows;
  }

  /** GET /gst/invoices/:id — full detail including lines. */
  async getInvoice(
    shopId: string,
    invoiceId: string,
  ): Promise<{ invoice: GstInvoiceRow; lines: GstInvoiceLineRow[] }> {
    const { rows } = await this.pool.query<GstInvoiceRow>(
      `SELECT * FROM gst_invoice WHERE shop_id = $1 AND invoice_id = $2`,
      [shopId, invoiceId],
    );
    if (!rows[0]) throw new NotFoundException('gst invoice not found');
    const { rows: lines } = await this.pool.query<GstInvoiceLineRow>(
      `SELECT * FROM gst_invoice_line WHERE invoice_id = $1 ORDER BY created_at, invoice_line_id`,
      [invoiceId],
    );
    return { invoice: rows[0], lines };
  }
}
