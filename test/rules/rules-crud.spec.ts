import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { RulesService } from '../../src/modules/rules/rules.service';
import { SavedZonesService } from '../../src/modules/rules/saved-zones.service';
import { parsePincodeCsv } from '../../src/modules/rules/pincode-csv';
import type { RuleInput } from '../../src/modules/rules/rules.service';
import { FnPool, mockAudit } from '../booking/helpers';
import { uniqueViolation } from '../team/helpers';
import { RULE_ID, RULE_ID_2, SHOP_ID, SVC_A, ZONE_ID } from './helpers';

const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

/**
 * Rule & saved-zone CRUD: INV-22 version checks, §5.3 delete-only-while-
 * unused, §9.4.1 position handling, §12 audits, §3.9/ADD field-operator
 * validation, §5.1-bounded CSV uploads with 6-digit normalization.
 */

function ruleInput(over: Partial<RuleInput> = {}): RuleInput {
  return {
    name: 'NE exclusion',
    actionType: 'PRIORITY_CHAIN',
    groups: [
      {
        conditions: [
          { field: 'DEST_STATE', operator: 'NOT_IN_LIST', value: { list: ['Assam'] } },
        ],
      },
    ],
    actionServiceIds: [SVC_A],
    ...over,
  };
}

function ruleRow(over: Record<string, unknown> = {}) {
  return {
    rule_id: RULE_ID,
    shop_id: SHOP_ID,
    name: 'NE exclusion',
    pickup_location_id: null,
    is_active: true,
    position: 3,
    action_type: 'PRIORITY_CHAIN',
    excluded_service_ids: [],
    active_from: null,
    active_to: null,
    version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function stagedRules() {
  const pool = new FnPool();
  const audit = mockAudit();
  const svc = new RulesService(pool.asPool(), audit as never);
  return { pool, audit, svc };
}

describe('RulesService.create', () => {
  it('appends at max(position)+1, inserts children, audits rule.create (§12)', async () => {
    const { pool, audit, svc } = stagedRules();
    pool.on(/FROM service WHERE/, [{ service_id: SVC_A }]);
    pool.on(/MAX\(position\)/, [{ next: 3 }]);
    pool.on(/INSERT INTO rule\b/, [{ rule_id: RULE_ID }]);
    pool.on(/INSERT INTO rule_condition_group/, [{ group_id: 'g1' }]);
    pool.on(/FROM rule WHERE/, [ruleRow()]);
    const view = await svc.create(SHOP_ID, MEMBER_ID, ruleInput());

    const insert = pool.matching(/INSERT INTO rule\b/)[0];
    expect(insert.params[0]).toBe(SHOP_ID); // INV-1
    expect(insert.params[2]).toBe(3); // appended at the bottom (§9.4.1)
    expect(pool.matching(/INSERT INTO rule_condition_group/)).toHaveLength(1);
    expect(pool.matching(/INSERT INTO rule_condition /)).toHaveLength(1);
    expect(pool.matching(/INSERT INTO rule_action_service/)).toHaveLength(1);
    expect(view.ruleId).toBe(RULE_ID);
    expect(audit.entries[0]).toMatchObject({ action: 'rule.create', objectId: RULE_ID });
  });

  it('rejects field/operator combinations outside §3.9 + ADD-01…12', async () => {
    const { svc } = stagedRules();
    await expect(
      svc.create(SHOP_ID, MEMBER_ID, ruleInput({
        groups: [{ conditions: [{ field: 'ZONE', operator: 'BETWEEN', value: { min: 'A', max: 'E' } }] }],
      })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(SHOP_ID, MEMBER_ID, ruleInput({
        groups: [{ conditions: [{ field: 'WEEKDAY', operator: 'GTE', value: { value: 'MON' } }] }],
      })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(SHOP_ID, MEMBER_ID, ruleInput({ actionServiceIds: [] })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(SHOP_ID, MEMBER_ID, ruleInput({
        groups: [{ conditions: [{ field: 'PINCODE', operator: 'IN_SAVED_ZONE', value: {} }] }],
      })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(SHOP_ID, MEMBER_ID, ruleInput({
        groups: [{ conditions: [{ field: 'PINCODE', operator: 'CSV_UPLOAD', value: { pincodes: ['11001'] } }] }],
      })),
    ).rejects.toBeInstanceOf(BadRequestException); // not 6 digits
  });
});

describe('RulesService.update (INV-22)', () => {
  it('version mismatch rejects with the current state, never a silent merge', async () => {
    const { pool, svc } = stagedRules();
    pool.on(/FROM service WHERE/, [{ service_id: SVC_A }]);
    pool.on(/FROM rule WHERE/, [ruleRow({ version: 5 })]);
    pool.on(/UPDATE rule\b/, [], 0); // version guard matched nothing
    await expect(
      svc.update(SHOP_ID, MEMBER_ID, RULE_ID, { ...ruleInput(), version: 4 }),
    ).rejects.toBeInstanceOf(ConflictException);
    // Rolled back: no child replacement happened.
    expect(pool.matching(/DELETE FROM rule_condition/)).toHaveLength(0);
  });

  it('happy path bumps the version, replaces children, audits rule.edit', async () => {
    const { pool, audit, svc } = stagedRules();
    pool.on(/FROM service WHERE/, [{ service_id: SVC_A }]);
    pool.on(/FROM rule WHERE/, [ruleRow()]);
    pool.on(/UPDATE rule\b/, [], 1);
    pool.on(/INSERT INTO rule_condition_group/, [{ group_id: 'g1' }]);
    const view = await svc.update(SHOP_ID, MEMBER_ID, RULE_ID, { ...ruleInput(), version: 1 });
    expect(view.ruleId).toBe(RULE_ID);
    const update = pool.matching(/UPDATE rule\b/)[0];
    expect(update.params[7]).toBe(1); // the version the writer read
    expect(pool.matching(/DELETE FROM rule_condition /)).toHaveLength(1);
    expect(pool.matching(/INSERT INTO rule_condition /)).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'rule.edit', objectId: RULE_ID });
  });
});

describe('RulesService.setActive + reorder', () => {
  it('audits rule.activate / rule.deactivate with a version check', async () => {
    const { pool, audit, svc } = stagedRules();
    pool.on(/UPDATE rule\b/, [], 1);
    pool.on(/FROM rule WHERE/, [ruleRow({ is_active: false })]);
    await svc.setActive(SHOP_ID, MEMBER_ID, RULE_ID, false, 1);
    expect(audit.entries[0]).toMatchObject({ action: 'rule.deactivate', objectId: RULE_ID });
    const update = pool.matching(/UPDATE rule\b/)[0];
    expect(update.params[3]).toBe(1); // INV-22
  });

  it('reorder requires the shop\'s full rule set; positions follow the list', async () => {
    const { pool, svc } = stagedRules();
    pool.on(/SELECT rule_id FROM rule /, [{ rule_id: RULE_ID }, { rule_id: RULE_ID_2 }]);
    await expect(svc.reorder(SHOP_ID, MEMBER_ID, [RULE_ID])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await svc.reorder(SHOP_ID, MEMBER_ID, [RULE_ID_2, RULE_ID]);
    const updates = pool.matching(/UPDATE rule SET position/);
    expect(updates[0].params).toEqual([SHOP_ID, RULE_ID_2, 1]);
    expect(updates[1].params).toEqual([SHOP_ID, RULE_ID, 2]);
  });
});

describe('RulesService.remove (§5.3)', () => {
  it('a rule referenced by any trace is never hard-deleted', async () => {
    const { pool, svc } = stagedRules();
    pool.on(/FROM rule WHERE/, [ruleRow()]);
    pool.on(/FROM rule_evaluation_trace/, [{ n: 2 }]);
    await expect(svc.remove(SHOP_ID, MEMBER_ID, RULE_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(pool.matching(/DELETE FROM rule /)).toHaveLength(0);
  });

  it('an unused rule deletes and audits rule.delete', async () => {
    const { pool, audit, svc } = stagedRules();
    pool.on(/FROM rule WHERE/, [ruleRow()]);
    pool.on(/FROM rule_evaluation_trace/, [{ n: 0 }]);
    pool.on(/DELETE FROM rule /, [], 1);
    await svc.remove(SHOP_ID, MEMBER_ID, RULE_ID);
    expect(audit.entries[0]).toMatchObject({ action: 'rule.delete', objectId: RULE_ID });
  });
});

describe('SavedZonesService', () => {
  function stagedZones() {
    const pool = new FnPool();
    const audit = mockAudit();
    const svc = new SavedZonesService(pool.asPool(), audit as never);
    return { pool, audit, svc };
  }

  const zoneRow = (over: Record<string, unknown> = {}) => ({
    saved_zone_id: ZONE_ID,
    shop_id: SHOP_ID,
    name: 'NCR',
    pincodes: ['110001', '560001'],
    version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  });

  it('create with CSV: normalized 6-digit pincodes, invalid rows reported (INV-20)', async () => {
    const { pool, audit, svc } = stagedZones();
    pool.on(/INSERT INTO saved_zone/, [zoneRow()]);
    const view = await svc.create(SHOP_ID, MEMBER_ID, {
      name: 'NCR',
      csv: '110001, 4000-01\n560001;110001',
    });
    const insert = pool.matching(/INSERT INTO saved_zone/)[0];
    expect(insert.params[2]).toEqual(['110001', '560001']); // trimmed, deduped
    expect(view.csvErrors).toEqual([{ row: 1, value: '4000-01', reason: 'not a 6-digit pincode' }]);
    expect(audit.entries[0]).toMatchObject({ action: 'saved_zone.create' });
  });

  it('duplicate (shop, name) is a 409, not a crash', async () => {
    const { pool, svc } = stagedZones();
    pool.onFn(/INSERT INTO saved_zone/, () => {
      throw uniqueViolation();
    });
    await expect(svc.create(SHOP_ID, MEMBER_ID, { name: 'NCR' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('update carries the INV-22 version; delete blocked while referenced (§5.3)', async () => {
    const { pool, svc } = stagedZones();
    pool.on(/FROM saved_zone WHERE/, [zoneRow()]);
    pool.on(/UPDATE saved_zone/, [], 0);
    await expect(
      svc.update(SHOP_ID, MEMBER_ID, ZONE_ID, { name: 'NCR2', version: 9 }),
    ).rejects.toBeInstanceOf(ConflictException);

    const pool2 = new FnPool();
    const svc2 = new SavedZonesService(pool2.asPool(), mockAudit() as never);
    pool2.on(/FROM saved_zone WHERE/, [zoneRow()]);
    pool2.on(/FROM rule_condition/, [{ n: 1 }]);
    await expect(svc2.remove(SHOP_ID, MEMBER_ID, ZONE_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(pool2.matching(/DELETE FROM saved_zone/)).toHaveLength(0);
  });
});

describe('pincode CSV parsing (§9.4.2, §5.1 bound)', () => {
  it('splits lines/commas/semicolons, normalizes, dedupes, reports bad rows', () => {
    const { pincodes, errors } = parsePincodeCsv('110001, 560001\n400001; 110001\nabc\n11001');
    expect(pincodes).toEqual(['110001', '560001', '400001']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ row: 3, value: 'abc' });
  });
});
