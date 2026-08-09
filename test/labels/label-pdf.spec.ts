import { describe, expect, it } from 'vitest';
import {
  buildLabelBlocks,
  buildLabelPdf,
  buildMergedLabelPdf,
  cellRect,
  cellsPerPage,
  COD_FONT,
  formatInr,
  isPositiveDecimal,
  LabelBlock,
  pageDimensions,
} from '../../src/modules/labels/label-pdf';
import { renderInput, snapshot, toggles } from './helpers';

/**
 * The custom label renderer (§9.9.1 CUSTOM_ALLOWED): S-24 toggles, the
 * always-emphasized COD collectible, the §9.23 TEST marker, S-23 geometry
 * and string-only money display.
 */

function block(ids: LabelBlock[], id: string) {
  return ids.find((b) => b.id === id);
}

function withToggles(t: Parameters<typeof toggles>[0]) {
  const input = renderInput();
  input.template.toggles = toggles(t);
  return input;
}

describe('buildLabelBlocks — S-24 defaults and toggles', () => {
  it('S-24 defaults show product list, SKU, barcode, GST, weight/dims, routing; prices off', () => {
    const blocks = buildLabelBlocks(renderInput());
    expect(block(blocks, 'products')).toBeDefined();
    expect(block(blocks, 'orderBarcode')).toBeDefined();
    expect(block(blocks, 'gst')).toBeDefined();
    expect(block(blocks, 'weightDims')).toBeDefined();
    expect(block(blocks, 'routingCode')).toBeDefined();
    expect(block(blocks, 'prices')).toBeUndefined();
  });

  it('productList toggle hides the products block', () => {
    const blocks = buildLabelBlocks(withToggles({ productList: false }));
    expect(block(blocks, 'products')).toBeUndefined();
  });

  it('sku toggle hides only the SKU lines inside the products block', () => {
    const withSku = buildLabelBlocks(renderInput());
    expect(block(withSku, 'products')!.lines.some((l) => l.text.startsWith('SKU:'))).toBe(true);
    const withoutSku = buildLabelBlocks(withToggles({ sku: false }));
    expect(block(withoutSku, 'products')).toBeDefined();
    expect(block(withoutSku, 'products')!.lines.some((l) => l.text.startsWith('SKU:'))).toBe(false);
  });

  it('orderBarcode toggle hides the barcode block; its value is the order number', () => {
    const blocks = buildLabelBlocks(renderInput());
    expect(block(blocks, 'orderBarcode')!.barcodeValue).toBe('1001');
    const off = buildLabelBlocks(withToggles({ orderBarcode: false }));
    expect(block(off, 'orderBarcode')).toBeUndefined();
  });

  it('orderBarcode falls back to the AWB when there is no order number', () => {
    const input = renderInput({ orderNumber: null });
    expect(block(buildLabelBlocks(input), 'orderBarcode')!.barcodeValue).toBe('AWB123456789');
  });

  it('gstNumber toggle hides the GSTIN block', () => {
    const off = buildLabelBlocks(withToggles({ gstNumber: false }));
    expect(block(off, 'gst')).toBeUndefined();
    const on = buildLabelBlocks(renderInput());
    expect(block(on, 'gst')!.lines[0].text).toContain('29ABCDE1234F1Z5');
  });

  it('weightDims toggle hides the weight/dims block', () => {
    const off = buildLabelBlocks(withToggles({ weightDims: false }));
    expect(block(off, 'weightDims')).toBeUndefined();
    const on = buildLabelBlocks(renderInput());
    expect(block(on, 'weightDims')!.lines[0].text).toContain('1.000 kg');
    expect(block(on, 'weightDims')!.lines[0].text).toContain('25.00x20.00x10.00 cm');
  });

  it('routingCode toggle hides the routing block', () => {
    const off = buildLabelBlocks(withToggles({ routingCode: false }));
    expect(block(off, 'routingCode')).toBeUndefined();
    const on = buildLabelBlocks(renderInput());
    expect(block(on, 'routingCode')!.lines[0].text).toContain('Zone B');
  });

  it('prices toggle shows the prices block when on', () => {
    const on = buildLabelBlocks(withToggles({ prices: true }));
    expect(block(on, 'prices')).toBeDefined();
    expect(block(on, 'prices')!.lines.some((l) => l.text.includes('Rs 499.00'))).toBe(true);
  });
});

describe('the COD collectible is always emphasized (S-24 — not a toggle)', () => {
  it('renders boxed, in the largest font on the label', () => {
    const blocks = buildLabelBlocks(renderInput());
    const cod = block(blocks, 'cod')!;
    expect(cod.boxed).toBe(true);
    expect(cod.lines[0].fontSize).toBe(COD_FONT);
    const maxOther = Math.max(
      ...blocks.filter((b) => b.id !== 'cod').flatMap((b) => b.lines.map((l) => l.fontSize)),
    );
    expect(cod.lines[0].fontSize).toBeGreaterThan(maxOther);
    expect(cod.lines[0].text).toBe('COD Rs 1250.50');
  });

  it('stays emphasized even when prices are on and the shipment is COD', () => {
    const blocks = buildLabelBlocks(withToggles({ prices: true }));
    expect(block(blocks, 'cod')).toBeDefined();
    expect(block(blocks, 'cod')!.boxed).toBe(true);
  });

  it('disappears only when the shipment carries no collectible', () => {
    const input = renderInput({
      snapshot: snapshot({ payment: { mode: 'PREPAID', collectible: '0', currency: 'INR' } }),
    });
    expect(block(buildLabelBlocks(input), 'cod')).toBeUndefined();
  });
});

describe('hide amounts on prepaid (S-24)', () => {
  const prepaidSnapshot = () =>
    snapshot({ payment: { mode: 'PREPAID', collectible: '0', currency: 'INR' } });

  it('hides the prices block on a prepaid shipment even when prices are on', () => {
    const input = renderInput({ snapshot: prepaidSnapshot() });
    input.template.toggles = toggles({ prices: true, hideAmountsOnPrepaid: true });
    expect(block(buildLabelBlocks(input), 'prices')).toBeUndefined();
  });

  it('shows prices on prepaid when hideAmountsOnPrepaid is off', () => {
    const input = renderInput({ snapshot: prepaidSnapshot() });
    input.template.toggles = toggles({ prices: true, hideAmountsOnPrepaid: false });
    expect(block(buildLabelBlocks(input), 'prices')).toBeDefined();
  });
});

describe('§9.23 / INV-19 test marker', () => {
  it('a test shipment carries a visible TEST marker', () => {
    const blocks = buildLabelBlocks(renderInput({ isTest: true }));
    const marker = block(blocks, 'testMarker')!;
    expect(marker.lines[0].text).toBe('TEST SHIPMENT');
    expect(marker.boxed).toBe(true);
    expect(blocks[0].id).toBe('testMarker');
  });

  it('a live shipment has no marker', () => {
    expect(block(buildLabelBlocks(renderInput()), 'testMarker')).toBeUndefined();
  });
});

describe('S-23 page geometry', () => {
  it('thermal 4×6 is a 288×432pt page, one label per page', () => {
    expect(pageDimensions('THERMAL_4X6')).toEqual({ width: 288, height: 432 });
    expect(cellsPerPage('THERMAL_4X6')).toBe(1);
    expect(cellRect('THERMAL_4X6', 0)).toEqual({ x: 0, y: 0, w: 288, h: 432 });
  });

  it('A4 2-up stacks two half-pages top-to-bottom', () => {
    expect(cellsPerPage('A4_2UP')).toBe(2);
    expect(cellRect('A4_2UP', 0)).toEqual({ x: 0, y: 421, w: 595, h: 421 });
    expect(cellRect('A4_2UP', 1)).toEqual({ x: 0, y: 0, w: 595, h: 421 });
  });

  it('A4 4-up places quadrants in reading order (top-left, top-right, bottom-left, bottom-right)', () => {
    expect(cellsPerPage('A4_4UP')).toBe(4);
    expect(cellRect('A4_4UP', 0)).toEqual({ x: 0, y: 421, w: 297.5, h: 421 });
    expect(cellRect('A4_4UP', 1)).toEqual({ x: 297.5, y: 421, w: 297.5, h: 421 });
    expect(cellRect('A4_4UP', 2)).toEqual({ x: 0, y: 0, w: 297.5, h: 421 });
    expect(cellRect('A4_4UP', 3)).toEqual({ x: 297.5, y: 0, w: 297.5, h: 421 });
  });

  it('rejects out-of-range cell indexes', () => {
    expect(() => cellRect('A4_2UP', 2)).toThrow();
  });
});

describe('PDF output', () => {
  it('builds a single-page label PDF', () => {
    const pdf = buildLabelPdf(renderInput(), 'THERMAL_4X6');
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 1');
    expect(text).toContain('/MediaBox [0 0 288 432]');
    expect(text).toContain('(AWB: AWB123456789)');
    expect(text).toContain('(COD Rs 1250.50)');
  });

  it('merges one page per shipment (§9.9.1 bulk)', () => {
    const pdf = buildMergedLabelPdf([renderInput(), renderInput()], 'THERMAL_4X6');
    expect(pdf.toString('latin1')).toContain('/Count 2');
  });

  it('draws barcode bars as filled rects', () => {
    const pdf = buildLabelPdf(renderInput(), 'THERMAL_4X6').toString('latin1');
    expect(pdf).toMatch(/\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)? 26 re f/);
  });
});

describe('string-only money display (INV-15 — no floats)', () => {
  it('isPositiveDecimal', () => {
    expect(isPositiveDecimal('1250.50')).toBe(true);
    expect(isPositiveDecimal('0.001')).toBe(true);
    expect(isPositiveDecimal('0.000')).toBe(false);
    expect(isPositiveDecimal('0')).toBe(false);
    expect(isPositiveDecimal('')).toBe(false);
    expect(isPositiveDecimal(null)).toBe(false);
    expect(isPositiveDecimal(undefined)).toBe(false);
  });

  it('formatInr rounds half-up to paise on the decimal string', () => {
    expect(formatInr('1250.50')).toBe('Rs 1250.50');
    expect(formatInr('0.004')).toBe('Rs 0.00');
    expect(formatInr('0.005')).toBe('Rs 0.01');
    expect(formatInr('99.999')).toBe('Rs 100.00');
    expect(formatInr('7')).toBe('Rs 7.00');
    expect(formatInr(null)).toBe('Rs 0.00');
  });
});
