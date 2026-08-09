import { describe, expect, it } from 'vitest';
import { I18nService } from '../../src/modules/platform/i18n/i18n.service';

// The default locales dir resolves to src/modules/platform/locales.
const i18n = new I18nService();

describe('I18nService (§9.20)', () => {
  it('returns the English string by default', () => {
    expect(i18n.t('settings.store.language')).toBe('Default language');
  });

  it('interpolates {param} placeholders', () => {
    expect(i18n.t('access.noAccess.body', { shopName: 'kirana-store' })).toContain(
      'kirana-store',
    );
    expect(
      i18n.t('access.noAccess.body', { shopName: 'kirana-store' }),
    ).not.toContain('{shopName}');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(i18n.t('access.noAccess.body', {})).toContain('{shopName}');
  });

  it('falls back to English for a language with no locale file', () => {
    expect(i18n.t('common.save', undefined, 'hi')).toBe('Save');
  });

  it('falls back to the raw key when the key is missing everywhere', () => {
    expect(i18n.t('does.not.exist')).toBe('does.not.exist');
    expect(i18n.t('does.not.exist', undefined, 'hi')).toBe('does.not.exist');
  });

  it('caches per language (repeated lookups stay consistent)', () => {
    expect(i18n.t('onboarding.step.testBooking')).toBe('Test booking');
    expect(i18n.t('onboarding.step.testBooking')).toBe('Test booking');
  });

  it('lists available languages from the locales dir', () => {
    expect(i18n.availableLanguages()).toContain('en');
  });
});
