import { describe, expect, it } from 'vitest';
import {
  matcherMatches,
  resolveZone,
  validateMatcher,
  type PincodeAttributes,
  type ZoneMatcher,
  type ZoneRuleInput,
} from '../../src/modules/rate-engine/pricing';

/**
 * §4.3 F-4 zone resolution: matcher semantics (exact / list / prefix /
 * boolean, ANDed within a matcher), position order with first match wins,
 * attributes from the frozen postal version, and no-match → unpriceable
 * (§4.1), never a guessed zone.
 */

const ATTRS = (over: Partial<PincodeAttributes> = {}): PincodeAttributes => ({
  pincode: '380015',
  city: 'Ahmedabad',
  district: 'Ahmedabad',
  state: 'Gujarat',
  region: 'West',
  isMetro: false,
  isSpecial: false,
  ...over,
});

describe('F-4 matcher semantics', () => {
  it('exact match is case-folded and trimmed', () => {
    expect(matcherMatches({ state: 'gujarat' }, ATTRS())).toBe(true);
    expect(matcherMatches({ state: ' Gujarat ' }, ATTRS())).toBe(true);
    expect(matcherMatches({ state: 'Maharashtra' }, ATTRS())).toBe(false);
  });

  it('list matches any member', () => {
    expect(matcherMatches({ state: ['Assam', 'Gujarat'] }, ATTRS())).toBe(true);
    expect(matcherMatches({ state: ['Assam', 'Bihar'] }, ATTRS())).toBe(false);
  });

  it('prefix matches text attributes (single or list)', () => {
    expect(matcherMatches({ pincode: { prefix: '38' } }, ATTRS())).toBe(true);
    expect(matcherMatches({ pincode: { prefix: ['11', '38'] } }, ATTRS())).toBe(true);
    expect(matcherMatches({ pincode: { prefix: '11' } }, ATTRS())).toBe(false);
  });

  it('boolean flags match is_metro / is_special', () => {
    expect(matcherMatches({ is_metro: false }, ATTRS())).toBe(true);
    expect(matcherMatches({ is_metro: true }, ATTRS())).toBe(false);
    expect(matcherMatches({ is_special: true }, ATTRS({ isSpecial: true }))).toBe(true);
  });

  it('predicates within a matcher are ANDed', () => {
    const both: ZoneMatcher = { state: 'Gujarat', pincode: { prefix: '38' } };
    expect(matcherMatches(both, ATTRS())).toBe(true);
    expect(matcherMatches(both, ATTRS({ state: 'Rajasthan' }))).toBe(false);
  });

  it('empty matcher matches everything (catch-all)', () => {
    expect(matcherMatches({}, ATTRS())).toBe(true);
  });

  it('missing attribute data never matches a predicate', () => {
    expect(matcherMatches({ city: 'Ahmedabad' }, ATTRS({ city: null }))).toBe(false);
    expect(matcherMatches({ is_metro: false }, ATTRS({ isMetro: null }))).toBe(false);
  });
});

describe('F-4 resolution — position order, first match wins', () => {
  const origin = { pincode: '380015', attributes: ATTRS() };
  const destinationAttrs = ATTRS({ pincode: '110001', city: 'New Delhi', state: 'Delhi', isMetro: true });

  const rules: ZoneRuleInput[] = [
    {
      originMatcher: {},
      destinationMatcher: { pincode: { prefix: '11' } },
      zone: 'C',
      position: 1,
    },
    {
      originMatcher: {},
      destinationMatcher: {},
      zone: 'E', // catch-all — only reached when nothing earlier matches
      position: 2,
    },
  ];

  it('matches the first rule in position order', () => {
    const zone = resolveZone(rules, origin, {
      pincode: '110001',
      attributes: destinationAttrs,
    });
    expect(zone).toBe('C');
  });

  it('earlier positions win over later broader rules', () => {
    const reordered: ZoneRuleInput[] = [
      { originMatcher: {}, destinationMatcher: {}, zone: 'E', position: 1 },
      { originMatcher: {}, destinationMatcher: { pincode: { prefix: '11' } }, zone: 'C', position: 2 },
    ];
    expect(
      resolveZone(reordered, origin, { pincode: '110001', attributes: destinationAttrs }),
    ).toBe('E');
  });

  it('falls through to the catch-all when no specific rule matches', () => {
    expect(
      resolveZone(rules, origin, { pincode: '700001', attributes: ATTRS({ pincode: '700001' }) }),
    ).toBe('E');
  });

  it('no matching rule → null → unpriceable (§4.1), never a guess', () => {
    const noCatchAll = rules.filter((r) => r.position === 1);
    expect(
      resolveZone(noCatchAll, origin, { pincode: '700001', attributes: ATTRS({ pincode: '700001' }) }),
    ).toBeNull();
    expect(resolveZone([], origin, { pincode: '700001', attributes: null })).toBeNull();
  });

  it('origin and destination matchers are both evaluated', () => {
    const originScoped: ZoneRuleInput[] = [
      {
        originMatcher: { state: 'Maharashtra' },
        destinationMatcher: {},
        zone: 'A',
        position: 1,
      },
    ];
    expect(
      resolveZone(originScoped, origin, { pincode: '110001', attributes: destinationAttrs }),
    ).toBeNull();
  });

  it('a pincode absent from the frozen master still matches pincode predicates but no attribute predicates', () => {
    const pincodeRule: ZoneRuleInput[] = [
      { originMatcher: {}, destinationMatcher: { pincode: { prefix: '99' } }, zone: 'D', position: 1 },
      { originMatcher: {}, destinationMatcher: { state: 'Gujarat' }, zone: 'B', position: 2 },
    ];
    // attributes: null — the row is absent from the frozen postal_version_id.
    expect(resolveZone(pincodeRule, origin, { pincode: '999999', attributes: null })).toBe('D');
    expect(resolveZone([pincodeRule[1]], origin, { pincode: '999999', attributes: null })).toBeNull();
  });
});

describe('validateMatcher — write-time shape guard', () => {
  it('accepts the documented shape', () => {
    expect(validateMatcher({})).toBe(true);
    expect(validateMatcher({ state: 'Gujarat' })).toBe(true);
    expect(validateMatcher({ state: ['A', 'B'] })).toBe(true);
    expect(validateMatcher({ pincode: { prefix: '38' } })).toBe(true);
    expect(validateMatcher({ pincode: { prefix: ['38', '39'] } })).toBe(true);
    expect(validateMatcher({ is_metro: true, is_special: false })).toBe(true);
  });

  it('rejects anything outside the shape', () => {
    expect(validateMatcher(null)).toBe(false);
    expect(validateMatcher([])).toBe(false);
    expect(validateMatcher('state')).toBe(false);
    expect(validateMatcher({ country: 'IN' })).toBe(false); // unknown attribute
    expect(validateMatcher({ state: true })).toBe(false); // boolean on a text attribute
    expect(validateMatcher({ is_metro: 'yes' })).toBe(false); // text on a flag
    expect(validateMatcher({ state: [] })).toBe(false); // empty list
    expect(validateMatcher({ pincode: { contains: '38' } })).toBe(false); // unknown operator
    expect(validateMatcher({ pincode: { prefix: 38 } })).toBe(false);
    expect(validateMatcher({ pincode: { prefix: [] } })).toBe(false);
  });
});
