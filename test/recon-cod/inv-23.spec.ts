import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodDueSweepService } from '../../src/modules/recon-cod/cod-due-sweep.service';
import { CodExpectationService } from '../../src/modules/recon-cod/cod-expectation.service';
import { CodImportService } from '../../src/modules/recon-cod/cod-import.service';
import { CodQueryService } from '../../src/modules/recon-cod/cod-query.service';
import { CodReconTrackingSeam } from '../../src/modules/recon-cod/cod-recon-tracking-seam';
import { CodSettingsService } from '../../src/modules/recon-cod/cod-settings.service';
import { CodReconProcessor, CodReconQueueService } from '../../src/modules/recon-cod/recon-cod-queue';
import { ReconCodController } from '../../src/modules/recon-cod/recon-cod.controller';

/**
 * INV-23 (§9.17.3): this module records money that moved between the courier
 * and the merchant — Jsyxi is not a party. There must be no payout, balance,
 * wallet, escrow, disbursement, settlement or transfer action anywhere in the
 * module's public surface.
 */

const FORBIDDEN = /payout|pay[_-]?out|settle|disburs|escrow|wallet|transfer|withdraw|hold[_-]?(back|ing)?/i;

const PUBLIC_CLASSES = [
  CodDueSweepService,
  CodExpectationService,
  CodImportService,
  CodQueryService,
  CodReconTrackingSeam,
  CodSettingsService,
  CodReconQueueService,
  CodReconProcessor,
  ReconCodController,
];

describe('INV-23 money boundary', () => {
  it('no exported class has a payout/balance/settlement-shaped method', () => {
    const offenders: string[] = [];
    for (const cls of PUBLIC_CLASSES) {
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        if (FORBIDDEN.test(name)) offenders.push(`${cls.name}.${name}`);
      }
      for (const name of Object.getOwnPropertyNames(cls)) {
        if (['length', 'name', 'prototype'].includes(name)) continue;
        if (FORBIDDEN.test(name)) offenders.push(`${cls.name}.${name} (static)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file in the module declares a money-movement action', () => {
    // Scan method/property declarations in the module source (comments cite
    // INV-23 itself, so this targets code identifiers, not prose).
    const dir = join(__dirname, '..', '..', 'src', 'modules', 'recon-cod');
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      const codeOnly = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const decls = codeOnly.match(/(?:async\s+)?[a-zA-Z_]+\s*\(/g) ?? [];
      for (const d of decls) {
        const name = d.replace(/(?:async\s+)?/, '').replace(/\s*\($/, '');
        if (FORBIDDEN.test(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
