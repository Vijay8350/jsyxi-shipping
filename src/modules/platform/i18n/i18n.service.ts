import { Injectable } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * i18n scaffold (§9.20, S-1). Every UI string passes through this layer.
 *
 * A locale is a single flat JSON file at `<module>/locales/<lang>.json`
 * (`settings.store.title` style keys). Adding a language is dropping in one
 * file — zero code change. Lookup order: requested language, then English
 * (S-1 default), then the raw key so a missing string is visible, never blank.
 * No framework dependency: plain fs + a per-language cache.
 */

export const DEFAULT_LANGUAGE = 'en';

type Dict = Record<string, string>;

@Injectable()
export class I18nService {
  private readonly cache = new Map<string, Dict>();
  // Property, not a constructor param — Nest cannot inject primitives.
  private readonly localesDir: string = join(__dirname, '..', 'locales');

  /** Languages that have a locale file on disk. */
  availableLanguages(): string[] {
    // Deliberately tiny: the dropdown (S-1) ships ready for more locales.
    // Kept dynamic so a new file needs no code change.
    return readdirSync(this.localesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }

  t(
    key: string,
    params?: Record<string, string | number>,
    lang: string = DEFAULT_LANGUAGE,
  ): string {
    const template =
      this.load(lang)[key] ?? this.load(DEFAULT_LANGUAGE)[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
      name in params ? String(params[name]) : raw,
    );
  }

  private load(lang: string): Dict {
    const cached = this.cache.get(lang);
    if (cached) return cached;
    let dict: Dict = {};
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(this.localesDir, `${lang}.json`), 'utf8'),
      );
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        dict = parsed as Dict;
      }
    } catch {
      // Missing/unreadable locale file: fall back to English, then the key.
      dict = {};
    }
    this.cache.set(lang, dict);
    return dict;
  }
}
