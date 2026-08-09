/**
 * Code 39 barcode encoding (§7.4 S-24 "order barcode" toggle). Code 39 is a
 * self-checking, discrete symbology: each character is 9 elements (5 bars, 4
 * spaces), exactly 3 wide and 6 narrow; characters are separated by one
 * narrow inter-character space; the pattern is wrapped in `*` start/stop.
 * The table below is the standard assignment and is asserted for known
 * characters in test/labels/code39.spec.ts.
 */

/** 'n' = narrow, 'w' = wide; position 0 is a bar, elements alternate. */
export const CODE39_TABLE: Readonly<Record<string, string>> = {
  '0': 'nnnwwnwnn',
  '1': 'wnnwnnnnw',
  '2': 'nnwwnnnnw',
  '3': 'wnwwnnnnn',
  '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn',
  '6': 'nnwwwnnnn',
  '7': 'nnnwnnwnw',
  '8': 'wnnwnnwnn',
  '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw',
  B: 'nnwnnwnnw',
  C: 'wnwnnwnnn',
  D: 'nnnnwwnnw',
  E: 'wnnnwwnnn',
  F: 'nnwnwwnnn',
  G: 'nnnnnwwnw',
  H: 'wnnnnwwnn',
  I: 'nnwnnwwnn',
  J: 'nnnnwwwnn',
  K: 'wnnnnnnww',
  L: 'nnwnnnnww',
  M: 'wnwnnnnwn',
  N: 'nnnnwnnww',
  O: 'wnnnwnnwn',
  P: 'nnwnwnnwn',
  Q: 'nnnnnnwww',
  R: 'wnnnnnwwn',
  S: 'nnwnnnwwn',
  T: 'nnnnwnwwn',
  U: 'wwnnnnnnw',
  V: 'nwwnnnnnw',
  W: 'wwwnnnnnn',
  X: 'nwnnwnnnw',
  Y: 'wwnnwnnnn',
  Z: 'nwwnwnnnn',
  '-': 'nwnnnnwnw',
  '.': 'wwnnnnwnn',
  ' ': 'nwwnnnwnn',
  $: 'nwnwnwnnn',
  '/': 'nwnwnnnwn',
  '+': 'nwnnnwnwn',
  '%': 'nnnwnwnwn',
  '*': 'nwnnwnwnn', // start/stop only — never data
};

export const CODE39_START_STOP = '*';

/**
 * Map arbitrary text into the Code 39 alphabet: upper-case, and replace any
 * unsupported character with '-' (order references like "#1001" carry '#',
 * which Code 39 cannot encode).
 */
export function sanitizeCode39(text: string): string {
  return text
    .toUpperCase()
    .split('')
    .map((ch) => (ch !== CODE39_START_STOP && ch in CODE39_TABLE ? ch : '-'))
    .join('');
}

/**
 * One encoded element run: true = bar, false = space, `wide` selects the
 * width. Includes the leading/trailing `*` and the narrow inter-character
 * gaps. An empty input yields just the start/stop pair.
 */
export interface Code39Element {
  bar: boolean;
  wide: boolean;
}

export function encodeCode39(text: string): Code39Element[] {
  const data = CODE39_START_STOP + sanitizeCode39(text) + CODE39_START_STOP;
  const elements: Code39Element[] = [];
  for (let i = 0; i < data.length; i++) {
    const pattern = CODE39_TABLE[data[i]];
    for (let j = 0; j < pattern.length; j++) {
      elements.push({ bar: j % 2 === 0, wide: pattern[j] === 'w' });
    }
    if (i < data.length - 1) {
      elements.push({ bar: false, wide: false }); // inter-character gap
    }
  }
  return elements;
}
