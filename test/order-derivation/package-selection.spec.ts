import { describe, expect, it } from 'vitest';
import {
  PackageProfileInput,
  selectPackageProfile,
} from '../../src/modules/order-derivation/package-selection';

/** F-20 package profile selection (§4.9, A4-03, RV-14). */

const small: PackageProfileInput = {
  packageProfileId: 'small',
  lengthCm: '25.00',
  widthCm: '20.00',
  heightCm: '10.00', // 5000 cm³
  tareKg: '0.040',
  isDefault: true,
};
const medium: PackageProfileInput = {
  packageProfileId: 'medium',
  lengthCm: '30.00',
  widthCm: '24.00',
  heightCm: '12.00', // 8640 cm³
  tareKg: '0.080',
  isDefault: false,
};
const big: PackageProfileInput = {
  packageProfileId: 'big',
  lengthCm: '40.00',
  widthCm: '40.00',
  heightCm: '40.00', // 64000 cm³
  tareKg: '0.200',
  isDefault: false,
};
const profiles = [small, medium, big];

function baseInput(overrides: Partial<Parameters<typeof selectPackageProfile>[0]> = {}) {
  return {
    lineSkus: ['TSHIRT-M'],
    skuOverrideProfiles: [],
    rules: [],
    profiles,
    contentWeightKg: '1.550',
    totalItems: 3,
    ...overrides,
  };
}

describe('selectPackageProfile (F-20, §4.9)', () => {
  it('rung 1: a sku_override.package_profile_id matching any line wins', () => {
    const result = selectPackageProfile(
      baseInput({ skuOverrideProfiles: [{ sku: 'TSHIRT-M', profile: medium }] }),
    );
    expect(result.source).toBe('SKU_OVERRIDE');
    expect(result.profile.packageProfileId).toBe('medium');
    expect(result.conflictResolvedByVolume).toBe(false);
  });

  it('rung 1 conflict (RV-14): two lines with different overrides → largest volume wins', () => {
    const result = selectPackageProfile(
      baseInput({
        lineSkus: ['TSHIRT-M', 'MUG-01'],
        skuOverrideProfiles: [
          { sku: 'TSHIRT-M', profile: small },
          { sku: 'MUG-01', profile: big },
        ],
      }),
    );
    expect(result.source).toBe('SKU_OVERRIDE');
    expect(result.profile.packageProfileId).toBe('big');
    expect(result.conflictResolvedByVolume).toBe(true);
  });

  it('rung 2: first matching package_selection_rule in POSITION order (not insertion order)', () => {
    const result = selectPackageProfile(
      baseInput({
        rules: [
          // Inserted big-first, but position 2 loses to position 1.
          { packageRuleId: 'r2', position: 2, minDeadKg: '1.000', maxDeadKg: null, minItems: null, maxItems: null, packageProfileId: 'big' },
          { packageRuleId: 'r1', position: 1, minDeadKg: null, maxDeadKg: null, minItems: null, maxItems: null, packageProfileId: 'medium' },
        ],
      }),
    );
    expect(result.source).toBe('SELECTION_RULE');
    expect(result.matchedRuleId).toBe('r1');
    expect(result.profile.packageProfileId).toBe('medium');
  });

  it('rung 2: rule bounds (weight and item count) must all match; null = unbounded', () => {
    const rules = [
      // Too heavy for this rule (max 1.000 < 1.550 content).
      { packageRuleId: 'r1', position: 1, minDeadKg: null, maxDeadKg: '1.000', minItems: null, maxItems: null, packageProfileId: 'small' },
      // Too many items (max 2 < 3).
      { packageRuleId: 'r2', position: 2, minDeadKg: null, maxDeadKg: null, minItems: null, maxItems: 2, packageProfileId: 'medium' },
      // Matches: 1.550 in [1.000, 2.000], 3 items ≥ 2.
      { packageRuleId: 'r3', position: 3, minDeadKg: '1.000', maxDeadKg: '2.000', minItems: 2, maxItems: null, packageProfileId: 'big' },
    ];
    const result = selectPackageProfile(baseInput({ rules }));
    expect(result.matchedRuleId).toBe('r3');
    expect(result.profile.packageProfileId).toBe('big');
  });

  it('rung 3: the is_default profile when nothing else matches (INV-24)', () => {
    const result = selectPackageProfile(baseInput());
    expect(result.source).toBe('DEFAULT');
    expect(result.profile.packageProfileId).toBe('small');
  });

  it('rung 3: missing default is an INV-24 data defect — throws, never a silent pick', () => {
    expect(() =>
      selectPackageProfile(baseInput({ profiles: [medium, big] })),
    ).toThrow(/INV-24/);
  });

  it('a rule whose target profile is gone is skipped, not crashed on (INV-20)', () => {
    const result = selectPackageProfile(
      baseInput({
        rules: [
          { packageRuleId: 'r1', position: 1, minDeadKg: null, maxDeadKg: null, minItems: null, maxItems: null, packageProfileId: 'deleted-profile' },
        ],
      }),
    );
    expect(result.source).toBe('DEFAULT');
  });
});
