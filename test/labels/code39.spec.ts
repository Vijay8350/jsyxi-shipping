import { describe, expect, it } from 'vitest';
import {
  CODE39_START_STOP,
  CODE39_TABLE,
  encodeCode39,
  sanitizeCode39,
} from '../../src/modules/labels/code39';

/** S-24 order-barcode symbology: the Code 39 table and encoder. */

describe('Code 39 encoding table', () => {
  it('matches the standard assignment for known characters', () => {
    expect(CODE39_TABLE['0']).toBe('nnnwwnwnn');
    expect(CODE39_TABLE['1']).toBe('wnnwnnnnw');
    expect(CODE39_TABLE['9']).toBe('nnwwnnwnn');
    expect(CODE39_TABLE.A).toBe('wnnnnwnnw');
    expect(CODE39_TABLE.K).toBe('wnnnnnnww');
    expect(CODE39_TABLE.Z).toBe('nwwnwnnnn');
    expect(CODE39_TABLE['-']).toBe('nwnnnnwnw');
    expect(CODE39_TABLE[' ']).toBe('nwwnnnwnn');
    expect(CODE39_TABLE[CODE39_START_STOP]).toBe('nwnnwnwnn');
  });

  it('every pattern is 9 elements with exactly 3 wide', () => {
    for (const [ch, pattern] of Object.entries(CODE39_TABLE)) {
      expect(pattern, ch).toHaveLength(9);
      expect(pattern.split('').filter((e) => e === 'w'), ch).toHaveLength(3);
      expect(pattern, ch).toMatch(/^[nw]+$/);
    }
    // The full Code 39 alphabet: 43 data characters + start/stop.
    expect(Object.keys(CODE39_TABLE)).toHaveLength(44);
  });
});

describe('encodeCode39', () => {
  it('wraps data in start/stop and alternates bar/space per character', () => {
    const elements = encodeCode39('A');
    // '*A*' → 3 characters × 9 elements + 2 inter-character gaps.
    expect(elements).toHaveLength(3 * 9 + 2);
    // First character is the start pattern: n w n n w n w n n →
    // narrow bar, wide space, narrow bar, narrow space, wide bar, ...
    const first9 = elements.slice(0, 9);
    expect(first9.map((e) => (e.bar ? 'B' : 's')).join('')).toBe('BsBsBsBsB');
    expect(first9.map((e) => (e.wide ? 'w' : 'n')).join('')).toBe('nwnnwnwnn');
    // Element 9 is the narrow inter-character gap (a space).
    expect(elements[9]).toEqual({ bar: false, wide: false });
    // 'A' follows with its own pattern.
    const aPattern = elements.slice(10, 19).map((e) => (e.wide ? 'w' : 'n')).join('');
    expect(aPattern).toBe('wnnnnwnnw');
  });

  it('encodes only bars as drawable elements with spaces between', () => {
    const elements = encodeCode39('0');
    for (let i = 0; i < elements.length; i++) {
      // Within a character, elements strictly alternate bar/space.
      const inGap = i % 10 === 9;
      if (!inGap) expect(elements[i].bar).toBe(i % 2 === 0);
    }
  });
});

describe('sanitizeCode39', () => {
  it('upper-cases and maps unsupported characters to -', () => {
    expect(sanitizeCode39('#1001')).toBe('-1001');
    expect(sanitizeCode39('ab-c')).toBe('AB-C');
    expect(sanitizeCode39('order ₹42')).toBe('ORDER -42');
    expect(sanitizeCode39('*')).toBe('-'); // start/stop is never data
  });
});
