/**
 * Minimal hand-rolled PDF writer (§9.5.5 manifests) — no dependencies.
 *
 * Produces a single-page PDF 1.4 document: one Helvetica font object
 * (14pt, one of the standard 14 fonts so no font file is embedded), one
 * content stream of text lines, a correct xref table and trailer. Kept
 * deliberately small: if a future document needs multi-page or tables,
 * extend here rather than pulling a dependency.
 *
 * Verified structurally in test/booking-ops/pdf.spec.ts (every xref offset
 * must point at its object header; the page count must be 1).
 */

export interface PdfTextPage {
  /** Top-to-bottom text lines, 14pt Helvetica with 20pt leading. */
  lines: string[];
}

const PDF_HEADER = '%PDF-1.4\n';
const PAGE_WIDTH = 595; // A4, pt
const PAGE_HEIGHT = 842;
const MARGIN_X = 50;
const START_Y = PAGE_HEIGHT - 60;
const FONT_SIZE = 14;
const LEADING = 20;

/** PDF literal-string escaping; non-ASCII bytes are flattened (the standard
 *  Helvetica encoding is single-byte — manifest fields are AWBs, numbers and
 *  codes, so this never loses required content). */
function escapeText(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function contentStream(page: PdfTextPage): string {
  const parts = [
    'BT',
    `/F1 ${FONT_SIZE} Tf`,
    `${LEADING} TL`,
    `${MARGIN_X} ${START_Y} Td`,
  ];
  page.lines.forEach((line, i) => {
    if (i > 0) parts.push('T*');
    parts.push(`(${escapeText(line)}) Tj`);
  });
  parts.push('ET');
  return parts.join('\n') + '\n';
}

/** Build a one-page PDF from text lines. Returns the raw bytes. */
export function buildSinglePagePdf(page: PdfTextPage): Buffer {
  const stream = contentStream(page);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
  ];

  let body = PDF_HEADER;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}
