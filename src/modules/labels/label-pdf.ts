import type { BookingSnapshot } from '../booking/booking.types';
import { encodeCode39, sanitizeCode39 } from './code39';
import type { LabelSize, LabelToggles } from './labels.types';

/**
 * Custom label renderer (§9.9.1, CUSTOM_ALLOWED services). Extends the
 * booking-ops hand-rolled PDF approach — multi-page, positioned text and
 * filled/stroked rects, one standard-14 Helvetica font, no dependencies —
 * without editing booking-ops' writer.
 *
 * INV-8: every fact on the label comes from the FROZEN booking snapshot. The
 * only exceptions are the AWB and the order number, which exist only after
 * the freeze (the AWB is assigned by the courier at CONFIRMED) and are passed
 * in by the caller from the shipment/order rows.
 *
 * S-24: content toggles decide which blocks exist. The COD collectible is
 * ALWAYS rendered emphasized (largest text + a box) when the shipment carries
 * one — it is not a toggle. Test shipments carry a visible TEST marker
 * (§9.23/INV-19).
 *
 * Standard-14 Helvetica is single-byte, so the rupee sign is written as
 * "Rs" — amounts use string-only decimal formatting (no floats for money).
 */

/* ---------------------------------------------------------------------------
 * PDF primitives.
 * ------------------------------------------------------------------------- */

export interface PdfTextOp {
  type: 'text';
  x: number;
  y: number;
  size: number;
  text: string;
}

export interface PdfRectOp {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  fill: boolean;
}

export type PdfOp = PdfTextOp | PdfRectOp;

export interface PdfPage {
  width: number;
  height: number;
  ops: PdfOp[];
}

/** PDF literal-string escaping; non-latin1 bytes are flattened (standard-14
 *  Helvetica is single-byte — label text is addresses, codes and digits). */
function escapeText(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function num(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function contentStream(page: PdfPage): string {
  const parts: string[] = ['1 w'];
  for (const op of page.ops) {
    if (op.type === 'text') {
      parts.push(`BT /F1 ${num(op.size)} Tf ${num(op.x)} ${num(op.y)} Td (${escapeText(op.text)}) Tj ET`);
    } else {
      parts.push(`${num(op.x)} ${num(op.y)} ${num(op.w)} ${num(op.h)} re ${op.fill ? 'f' : 'S'}`);
    }
  }
  return parts.join('\n') + '\n';
}

/** Build a multi-page PDF 1.4 document. Returns the raw bytes. */
export function buildPdf(pages: PdfPage[]): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((page, i) => {
    const stream = contentStream(page);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    );
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

/* ---------------------------------------------------------------------------
 * S-23 page geometry. PDF origin is bottom-left; cellRect answers in it.
 * ------------------------------------------------------------------------- */

const PT_PER_INCH = 72;
const A4_WIDTH = 595;
const A4_HEIGHT = 842;

export function pageDimensions(size: LabelSize): { width: number; height: number } {
  if (size === 'THERMAL_4X6') return { width: 4 * PT_PER_INCH, height: 6 * PT_PER_INCH };
  return { width: A4_WIDTH, height: A4_HEIGHT };
}

/** S-23: A4 1/2/4-up grid; thermal is always one label per page. */
export function cellsPerPage(size: LabelSize): 1 | 2 | 4 {
  if (size === 'A4_2UP') return 2;
  if (size === 'A4_4UP') return 4;
  return 1;
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grid placement, reading order: top-to-bottom, then left-to-right. */
export function cellRect(size: LabelSize, indexOnPage: number): CellRect {
  const { width, height } = pageDimensions(size);
  const cells = cellsPerPage(size);
  if (indexOnPage < 0 || indexOnPage >= cells) {
    throw new Error(`cell index ${indexOnPage} out of range for ${size}`);
  }
  if (cells === 1) return { x: 0, y: 0, w: width, h: height };
  if (cells === 2) {
    const h = height / 2;
    return { x: 0, y: indexOnPage === 0 ? h : 0, w: width, h };
  }
  const w = width / 2;
  const h = height / 2;
  const col = indexOnPage % 2;
  const row = Math.floor(indexOnPage / 2);
  return { x: col * w, y: row === 0 ? h : 0, w, h };
}

/* ---------------------------------------------------------------------------
 * Money display — string-only decimal math (INV-15; no floats for money).
 * ------------------------------------------------------------------------- */

/** True when a decimal string ('1250.50', '0.000') is strictly positive. */
export function isPositiveDecimal(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[+-]?(0*[1-9][0-9]*)(\.[0-9]+)?$|^[+-]?0*\.0*[1-9][0-9]*$/.test(value.trim());
}

/** Half-up rounding to 2 decimals on the decimal string itself. */
export function formatInr(value: string | null | undefined): string {
  if (!value) return 'Rs 0.00';
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value.trim());
  if (!m) return 'Rs 0.00';
  const [, sign, intPart, fracRaw = ''] = m;
  const cents = (fracRaw + '00').slice(0, 2);
  const roundUp = Number(fracRaw[2] ?? '0') >= 5;
  let paise = Number(cents) + (roundUp ? 1 : 0);
  let rupees = intPart.replace(/^0+(?=[0-9])/, '');
  if (paise >= 100) {
    paise -= 100;
    rupees = String(Number(rupees) + 1);
  }
  return `Rs ${sign}${rupees}.${paise.toString().padStart(2, '0')}`;
}

/* ---------------------------------------------------------------------------
 * Label blocks (S-24 toggles; the COD block is mandatory, never a toggle).
 * ------------------------------------------------------------------------- */

export type LabelBlockId =
  | 'testMarker'
  | 'brand'
  | 'routingCode'
  | 'awb'
  | 'shipTo'
  | 'cod'
  | 'from'
  | 'orderBarcode'
  | 'products'
  | 'weightDims'
  | 'gst'
  | 'prices'
  | 'footer';

export interface LabelLine {
  text: string;
  fontSize: number;
}

export interface LabelBlock {
  id: LabelBlockId;
  lines: LabelLine[];
  /** Emphasis box (the COD collectible). */
  boxed?: boolean;
  /** Code 39 payload when the block is a barcode. */
  barcodeValue?: string;
}

export const BODY_FONT = 8;
export const HEADER_FONT = 10;
/** The COD collectible is the largest text on the label (S-24, §9.9.1). */
export const COD_FONT = 18;
const SMALL_FONT = 7;

export interface LabelTemplateContent {
  brandName: string | null;
  supportPhone: string | null;
  messageLine: string | null;
  toggles: LabelToggles;
}

export interface LabelRenderInput {
  /** INV-8: the frozen booking snapshot — never current master data. */
  snapshot: BookingSnapshot;
  /** Assigned post-freeze by the courier; read off the shipment row. */
  awb: string | null;
  /** Display id for the order barcode ("order".shopify_order_number). */
  orderNumber: string | null;
  template: LabelTemplateContent;
  /** §9.23 / INV-19: test shipments are visibly marked wherever they appear. */
  isTest: boolean;
}

export function buildLabelBlocks(input: LabelRenderInput): LabelBlock[] {
  const { snapshot, template, awb, orderNumber, isTest } = input;
  const t = template.toggles;
  const blocks: LabelBlock[] = [];

  // §9.23 / INV-19 — a test shipment must never be mistaken for a real one.
  if (isTest) {
    blocks.push({ id: 'testMarker', boxed: true, lines: [{ text: 'TEST SHIPMENT', fontSize: HEADER_FONT }] });
  }

  blocks.push({
    id: 'brand',
    lines: [{ text: template.brandName ?? 'Jsyxi Shipping', fontSize: HEADER_FONT }],
  });

  if (t.routingCode && snapshot.zone) {
    blocks.push({ id: 'routingCode', lines: [{ text: `Routing: Zone ${snapshot.zone}`, fontSize: BODY_FONT }] });
  }

  blocks.push({
    id: 'awb',
    lines: [
      { text: `AWB: ${awb ?? '-'}`, fontSize: BODY_FONT },
      { text: `Service: ${snapshot.service.name} (${snapshot.service.code})`, fontSize: SMALL_FONT },
    ],
  });

  const r = snapshot.recipient;
  if (r) {
    const shipTo: LabelLine[] = [{ text: 'Ship to:', fontSize: SMALL_FONT }];
    if (r.name) shipTo.push({ text: r.name, fontSize: BODY_FONT });
    for (const line of r.addressLines) shipTo.push({ text: line, fontSize: BODY_FONT });
    const cityLine = [r.city, r.state, r.pincode].filter(Boolean).join(', ');
    if (cityLine) shipTo.push({ text: cityLine, fontSize: BODY_FONT });
    if (r.phone) shipTo.push({ text: `Ph: ${r.phone}`, fontSize: BODY_FONT });
    blocks.push({ id: 'shipTo', lines: shipTo });
  }

  // S-24 / §9.9.1: the COD collectible is ALWAYS emphasized — largest text,
  // boxed — whenever the shipment carries one. Not a toggle.
  if (isPositiveDecimal(snapshot.payment.collectible)) {
    blocks.push({
      id: 'cod',
      boxed: true,
      lines: [{ text: `COD ${formatInr(snapshot.payment.collectible)}`, fontSize: COD_FONT }],
    });
  }

  const p = snapshot.pickupLocation;
  if (p) {
    const fromLine = [p.name, p.city, p.pincode].filter(Boolean).join(', ');
    blocks.push({ id: 'from', lines: [{ text: `From: ${fromLine}`, fontSize: SMALL_FONT }] });
  }

  if (t.orderBarcode) {
    const value = sanitizeCode39(orderNumber ?? awb ?? '');
    if (value) {
      blocks.push({
        id: 'orderBarcode',
        barcodeValue: value,
        lines: [{ text: value, fontSize: SMALL_FONT }],
      });
    }
  }

  if (t.productList && snapshot.lines.length > 0) {
    const lines: LabelLine[] = [{ text: 'Contents:', fontSize: SMALL_FONT }];
    for (const line of snapshot.lines) {
      const title = [line.title ?? '-', line.variant].filter(Boolean).join(' - ');
      lines.push({ text: `${line.quantity} x ${title}`, fontSize: BODY_FONT });
      if (t.sku && line.sku) lines.push({ text: `SKU: ${line.sku}`, fontSize: SMALL_FONT });
    }
    blocks.push({ id: 'products', lines });
  }

  if (t.weightDims) {
    const kg = snapshot.weights.billableWeightKg ?? snapshot.weights.deadWeightKg;
    const dims = snapshot.packageProfile
      ? `${snapshot.packageProfile.lengthCm}x${snapshot.packageProfile.widthCm}x${snapshot.packageProfile.heightCm} cm`
      : null;
    blocks.push({
      id: 'weightDims',
      lines: [{ text: `Wt: ${kg} kg${dims ? `  Dim: ${dims}` : ''}`, fontSize: SMALL_FONT }],
    });
  }

  if (t.gstNumber && snapshot.pickupLocation?.gstin) {
    blocks.push({
      id: 'gst',
      lines: [{ text: `GSTIN: ${snapshot.pickupLocation.gstin}`, fontSize: SMALL_FONT }],
    });
  }

  // S-24: prices are off by default; "hide amounts on prepaid" hides every
  // amount on a prepaid shipment even when prices are toggled on. The COD
  // collectible above is unaffected — it is not a toggle.
  const amountsHidden = t.hideAmountsOnPrepaid && snapshot.payment.mode !== 'COD';
  if (t.prices && !amountsHidden) {
    const lines: LabelLine[] = [];
    for (const line of snapshot.lines) {
      if (line.unitPrice) lines.push({ text: `${line.title ?? '-'}: ${formatInr(line.unitPrice)}`, fontSize: SMALL_FONT });
    }
    if (isPositiveDecimal(snapshot.formulaInputs.declaredValue)) {
      lines.push({ text: `Declared: ${formatInr(snapshot.formulaInputs.declaredValue)}`, fontSize: SMALL_FONT });
    }
    if (lines.length > 0) blocks.push({ id: 'prices', lines });
  }

  const footer: LabelLine[] = [];
  if (template.messageLine) footer.push({ text: template.messageLine, fontSize: SMALL_FONT });
  if (template.supportPhone) footer.push({ text: `Support: ${template.supportPhone}`, fontSize: SMALL_FONT });
  if (footer.length > 0) blocks.push({ id: 'footer', lines: footer });

  return blocks;
}

/* ---------------------------------------------------------------------------
 * Painting blocks into a cell.
 * ------------------------------------------------------------------------- */

const CELL_PAD = 10;
const BLOCK_GAP = 6;
const BARCODE_HEIGHT = 26;
const BARCODE_NARROW = 1;
const BARCODE_WIDE = 3;

function leading(fontSize: number): number {
  return fontSize + 2;
}

/** Paint one label's blocks into a cell of a page (ops are appended). */
export function paintLabel(page: PdfPage, cell: CellRect, blocks: LabelBlock[]): void {
  let cursor = cell.y + cell.h - CELL_PAD; // PDF y at the top of the next block
  for (const block of blocks) {
    const blockHeight =
      block.lines.reduce((sum, l) => sum + leading(l.fontSize), 0) +
      (block.barcodeValue ? BARCODE_HEIGHT + leading(SMALL_FONT) : 0);
    if (block.boxed) {
      page.ops.push({
        type: 'rect',
        x: cell.x + CELL_PAD / 2,
        y: cursor - blockHeight - 2,
        w: cell.w - CELL_PAD,
        h: blockHeight + 6,
        fill: false,
      });
    }
    if (block.barcodeValue) {
      let x = cell.x + CELL_PAD;
      const y = cursor - BARCODE_HEIGHT;
      for (const el of encodeCode39(block.barcodeValue)) {
        const w = el.wide ? BARCODE_WIDE : BARCODE_NARROW;
        if (el.bar) page.ops.push({ type: 'rect', x, y, w, h: BARCODE_HEIGHT, fill: true });
        x += w;
      }
      cursor -= BARCODE_HEIGHT;
    }
    for (const line of block.lines) {
      cursor -= leading(line.fontSize);
      page.ops.push({
        type: 'text',
        x: cell.x + CELL_PAD,
        y: cursor,
        size: line.fontSize,
        text: line.text,
      });
    }
    cursor -= BLOCK_GAP;
  }
}

/**
 * One page per label, the label painted in the first cell of the page
 * (§9.9.1 bulk: "merge one page per Shipment"). Single-label generation is
 * the one-element case; A4 n-up grid placement is available through
 * cellRect/cellsPerPage for print-time packing.
 */
export function layoutLabelPages(inputs: LabelRenderInput[], size: LabelSize): PdfPage[] {
  return inputs.map((input) => {
    const dims = pageDimensions(size);
    const page: PdfPage = { width: dims.width, height: dims.height, ops: [] };
    paintLabel(page, cellRect(size, 0), buildLabelBlocks(input));
    return page;
  });
}

/** §9.9.1 single custom label (CUSTOM_ALLOWED). */
export function buildLabelPdf(input: LabelRenderInput, size: LabelSize): Buffer {
  return buildPdf(layoutLabelPages([input], size));
}

/** §9.9.1 bulk merged label PDF — one page per Shipment, order preserved. */
export function buildMergedLabelPdf(inputs: LabelRenderInput[], size: LabelSize): Buffer {
  return buildPdf(layoutLabelPages(inputs, size));
}
