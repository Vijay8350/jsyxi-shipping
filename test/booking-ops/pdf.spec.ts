import { describe, expect, it } from 'vitest';
import { buildSinglePagePdf } from '../../src/modules/booking-ops/pdf';

/**
 * Structural verification of the hand-rolled PDF writer (§9.5.5): parse our
 * own output — the xref table must exist where startxref says, every entry
 * must point at its object header, and the page count must be 1.
 */
describe('buildSinglePagePdf', () => {
  const pdf = buildSinglePagePdf({
    lines: ['Manifest MF-20260731-0001', 'AWB123 | #1001 | 0.540 | COD | 1250.50', 'parens (and) \\ backslash'],
  });
  const text = pdf.toString('latin1');

  it('has the PDF header and EOF marker', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('declares exactly one page', () => {
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('/F1 14 Tf');
  });

  it('startxref points at the xref table and every offset at its object', () => {
    const startxref = /startxref\n(\d+)\n%%EOF/.exec(text);
    expect(startxref).not.toBeNull();
    const xrefAt = Number(startxref![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');

    const xrefBlock = text.slice(xrefAt);
    const header = /xref\n0 (\d+)\n/.exec(xrefBlock);
    expect(header).not.toBeNull();
    const count = Number(header![1]);
    expect(count).toBe(6); // 5 objects + the free entry

    const entries = [...xrefBlock.matchAll(/(\d{10}) (\d{5}) ([nf]) /g)];
    expect(entries.length).toBe(count);
    expect(entries[0][3]).toBe('f'); // free entry
    for (let i = 1; i < count; i++) {
      const offset = Number(entries[i][1]);
      expect(entries[i][3]).toBe('n');
      expect(text.slice(offset, offset + 16)).toContain(`${i} 0 obj`);
    }
  });

  it('escapes literal-string specials and flattens non-ASCII', () => {
    const stream = /stream\n([\s\S]*?)endstream/.exec(text)![1];
    expect(stream).toContain('parens \\(and\\) \\\\ backslash');
    expect(buildSinglePagePdf({ lines: ['₹1250'] }).toString('latin1')).toContain('(?1250) Tj');
  });

  it('carries the manifest content lines', () => {
    expect(text).toContain('(Manifest MF-20260731-0001) Tj');
    expect(text).toContain('(AWB123 | #1001 | 0.540 | COD | 1250.50) Tj');
  });
});
