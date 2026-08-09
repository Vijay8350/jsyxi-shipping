import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { MAX_PINCODES_PER_ZONE } from './pincode-csv';
import type {
  ConditionValue,
  RuleActionType,
  RuleConditionField,
  RuleOperator,
} from './evaluate';
import type {
  RuleActionServiceRow,
  RuleConditionRow,
  RuleConditionGroupRow,
  RuleRow,
  RuleView,
} from './rules.types';

/**
 * Rule CRUD (§9.4.1). Every write is INV-22 version-checked (the writer
 * carries the version it read; a mismatch is a 409 with the current state,
 * never a silent merge) and audited per §12 (rule create / edit / activate /
 * deactivate / reorder / delete). §5.3: a rule is hard-deletable only while
 * unused — any rule_evaluation_trace reference means deactivate instead.
 */

/** §3.9 + ADD-01…ADD-12: the operators each field accepts. */
const FIELD_OPERATORS: Record<RuleConditionField, readonly RuleOperator[]> = {
  WEIGHT: ['EQUALS', 'BETWEEN', 'GTE', 'LTE'],
  ORDER_AMOUNT: ['EQUALS', 'BETWEEN', 'GTE', 'LTE'],
  PAYMENT_MODE: ['IS_COD', 'IS_PREPAID'],
  PINCODE: ['IN_LIST', 'NOT_IN_LIST', 'IN_SAVED_ZONE', 'CSV_UPLOAD'],
  SKU: ['IN_LIST', 'NOT_IN_LIST'],
  TAG: ['IN_LIST', 'NOT_IN_LIST'],
  DEST_STATE: ['IN_LIST', 'NOT_IN_LIST'], // ADD-01
  DEST_CITY: ['IN_LIST', 'NOT_IN_LIST'], // ADD-02
  ZONE: ['IN_LIST', 'NOT_IN_LIST'], // ADD-03
  COD_AMOUNT: ['EQUALS', 'BETWEEN', 'GTE', 'LTE'], // ADD-04
  ESTIMATED_FREIGHT: ['BETWEEN', 'GTE', 'LTE'], // ADD-05
  CHECKOUT_SHIPPING_TITLE: ['IN_LIST', 'NOT_IN_LIST', 'CONTAINS'], // ADD-06
  CHECKOUT_SHIPPING_AMOUNT: ['EQUALS', 'BETWEEN', 'GTE', 'LTE'], // ADD-07
  ITEM_COUNT: ['EQUALS', 'BETWEEN', 'GTE', 'LTE'], // ADD-08
  PRODUCT: ['IN_LIST', 'NOT_IN_LIST'], // ADD-09
  VENDOR: ['IN_LIST', 'NOT_IN_LIST'], // ADD-09
  COLLECTION: ['IN_LIST', 'NOT_IN_LIST'], // ADD-09
  VOLUMETRIC_WEIGHT: ['BETWEEN', 'GTE', 'LTE'], // ADD-10
  RISK_FLAG: ['IS_HIGH', 'IS_NOT_HIGH'], // ADD-11
  WEEKDAY: ['IN_LIST'], // ADD-12
  TIME_OF_DAY: ['BETWEEN'], // ADD-12
};

const PINCODE_RE = /^[0-9]{6}$/;

export interface ConditionInput {
  field: RuleConditionField;
  operator: RuleOperator;
  value: ConditionValue;
}

export interface RuleInput {
  name: string;
  actionType: RuleActionType;
  excludedServiceIds?: string[];
  activeFrom?: string | null;
  activeTo?: string | null;
  groups: { conditions: ConditionInput[] }[];
  actionServiceIds: string[];
}

export interface UpdateRuleInput extends RuleInput {
  /** INV-22: the version the writer read. */
  version: number;
}

@Injectable()
export class RulesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------- reads ---------------------------------- */

  private async loadChildren(
    db: { query: Pool['query'] },
    ruleIds: string[],
  ): Promise<{
    groups: RuleConditionGroupRow[];
    conditions: RuleConditionRow[];
    actionServices: RuleActionServiceRow[];
  }> {
    if (ruleIds.length === 0) return { groups: [], conditions: [], actionServices: [] };
    const [g, c, a] = await Promise.all([
      db.query<RuleConditionGroupRow>(
        `SELECT group_id, rule_id, position FROM rule_condition_group
          WHERE rule_id = ANY($1::uuid[]) ORDER BY position ASC`,
        [ruleIds],
      ),
      db.query<RuleConditionRow>(
        `SELECT condition_id, rule_id, group_id, field, operator, value_json
           FROM rule_condition WHERE rule_id = ANY($1::uuid[])`,
        [ruleIds],
      ),
      db.query<RuleActionServiceRow>(
        `SELECT action_service_id, rule_id, service_id, position
           FROM rule_action_service WHERE rule_id = ANY($1::uuid[]) ORDER BY position ASC`,
        [ruleIds],
      ),
    ]);
    return { groups: g.rows, conditions: c.rows, actionServices: a.rows };
  }

  private toView(
    rule: RuleRow,
    children: {
      groups: RuleConditionGroupRow[];
      conditions: RuleConditionRow[];
      actionServices: RuleActionServiceRow[];
    },
  ): RuleView {
    return {
      ruleId: rule.rule_id,
      name: rule.name,
      isActive: rule.is_active,
      position: rule.position,
      actionType: rule.action_type,
      excludedServiceIds: rule.excluded_service_ids ?? [],
      activeFrom: rule.active_from,
      activeTo: rule.active_to,
      version: rule.version,
      groups: children.groups
        .filter((g) => g.rule_id === rule.rule_id)
        .map((g) => ({
          groupId: g.group_id,
          position: g.position,
          conditions: children.conditions
            .filter((c) => c.group_id === g.group_id)
            .map((c) => ({
              conditionId: c.condition_id,
              field: c.field,
              operator: c.operator,
              value: c.value_json,
            })),
        })),
      actionServiceIds: children.actionServices
        .filter((a) => a.rule_id === rule.rule_id)
        .map((a) => a.service_id),
    };
  }

  async list(shopId: string): Promise<RuleView[]> {
    const { rows } = await this.pool.query<RuleRow>(
      `SELECT rule_id, shop_id, name, pickup_location_id, is_active, position,
              action_type, excluded_service_ids, active_from, active_to, version,
              created_at, updated_at
         FROM rule WHERE shop_id = $1 ORDER BY position ASC, created_at ASC`,
      [shopId],
    );
    const children = await this.loadChildren(this.pool, rows.map((r) => r.rule_id));
    return rows.map((r) => this.toView(r, children));
  }

  async get(shopId: string, ruleId: string): Promise<RuleView> {
    const { rows } = await this.pool.query<RuleRow>(
      `SELECT rule_id, shop_id, name, pickup_location_id, is_active, position,
              action_type, excluded_service_ids, active_from, active_to, version,
              created_at, updated_at
         FROM rule WHERE shop_id = $1 AND rule_id = $2`,
      [shopId, ruleId],
    );
    if (!rows[0]) throw new NotFoundException('rule not found');
    const children = await this.loadChildren(this.pool, [ruleId]);
    return this.toView(rows[0], children);
  }

  /* ---------------------------- validation --------------------------------- */

  private validateConditions(input: RuleInput): void {
    if (input.groups.length === 0) {
      throw new BadRequestException('a rule needs at least one condition group (ADD-13)');
    }
    for (const group of input.groups) {
      for (const cond of group.conditions) {
        const allowed = FIELD_OPERATORS[cond.field];
        if (!allowed) throw new BadRequestException(`unknown field ${cond.field}`);
        if (!allowed.includes(cond.operator)) {
          throw new BadRequestException(
            `${cond.field} does not accept operator ${cond.operator} (§3.9 / ADD-01…12)`,
          );
        }
        const v = cond.value ?? {};
        if (cond.operator === 'BETWEEN' && (v.min === undefined || v.max === undefined)) {
          throw new BadRequestException(`${cond.field} BETWEEN needs min and max`);
        }
        if (
          (cond.operator === 'EQUALS' || cond.operator === 'GTE' || cond.operator === 'LTE') &&
          v.value === undefined
        ) {
          throw new BadRequestException(`${cond.field} ${cond.operator} needs value`);
        }
        if (
          (cond.operator === 'IN_LIST' || cond.operator === 'NOT_IN_LIST') &&
          (!Array.isArray(v.list) || v.list.length === 0)
        ) {
          throw new BadRequestException(`${cond.field} ${cond.operator} needs a list`);
        }
        if (cond.operator === 'CONTAINS' && !((v.list?.[0] ?? v.value ?? '').trim())) {
          throw new BadRequestException('CONTAINS needs a non-empty needle');
        }
        if (cond.operator === 'IN_SAVED_ZONE' && !v.zoneId) {
          throw new BadRequestException('IN_SAVED_ZONE needs value.zoneId');
        }
        if (cond.operator === 'CSV_UPLOAD') {
          // §9.4.2: CSV uploads are normalized 6-digit pincodes, bounded by §5.1.
          const pincodes = v.pincodes ?? [];
          if (pincodes.length === 0) {
            throw new BadRequestException('CSV_UPLOAD needs value.pincodes');
          }
          if (pincodes.length > MAX_PINCODES_PER_ZONE) {
            throw new BadRequestException(`CSV_UPLOAD exceeds the §5.1 bound (${MAX_PINCODES_PER_ZONE})`);
          }
          const bad = pincodes.find((p) => !PINCODE_RE.test(p));
          if (bad) throw new BadRequestException(`invalid pincode in CSV_UPLOAD: ${bad}`);
        }
      }
    }
    if (input.actionType !== 'MANUAL_ONLY' && input.actionServiceIds.length === 0) {
      // Allowed by the model (the §4.5 chain fallback covers it) but almost
      // always a mistake — reject at write time (INV-20: nothing silent).
      throw new BadRequestException('a non-MANUAL_ONLY action needs at least one Service');
    }
  }

  private async assertServicesExist(
    db: { query: Pool['query'] },
    serviceIds: string[],
  ): Promise<void> {
    if (serviceIds.length === 0) return;
    const { rows } = await db.query<{ service_id: string }>(
      `SELECT service_id FROM service WHERE service_id = ANY($1::uuid[])`,
      [serviceIds],
    );
    const found = new Set(rows.map((r) => r.service_id));
    const missing = serviceIds.find((id) => !found.has(id));
    if (missing) throw new BadRequestException(`unknown service ${missing}`);
  }

  private async assertSavedZone(
    db: { query: Pool['query'] },
    shopId: string,
    input: RuleInput,
  ): Promise<void> {
    const zoneIds = [
      ...new Set(
        input.groups
          .flatMap((g) => g.conditions)
          .filter((c) => c.operator === 'IN_SAVED_ZONE')
          .map((c) => c.value.zoneId as string),
      ),
    ];
    if (zoneIds.length === 0) return;
    const { rows } = await db.query<{ saved_zone_id: string }>(
      `SELECT saved_zone_id FROM saved_zone
        WHERE shop_id = $1 AND saved_zone_id = ANY($2::uuid[])`,
      [shopId, zoneIds],
    );
    const found = new Set(rows.map((r) => r.saved_zone_id));
    const missing = zoneIds.find((id) => !found.has(id));
    if (missing) throw new NotFoundException(`saved zone ${missing} not found`);
  }

  /* ------------------------------- writes ---------------------------------- */

  private async insertChildren(
    db: { query: Pool['query'] },
    ruleId: string,
    input: RuleInput,
  ): Promise<void> {
    for (const [gi, group] of input.groups.entries()) {
      const { rows } = await db.query<{ group_id: string }>(
        `INSERT INTO rule_condition_group (rule_id, position) VALUES ($1, $2)
         RETURNING group_id`,
        [ruleId, gi + 1],
      );
      const groupId = rows[0].group_id;
      for (const cond of group.conditions) {
        await db.query(
          `INSERT INTO rule_condition (rule_id, group_id, field, operator, value_json)
           VALUES ($1, $2, $3, $4, $5)`,
          [ruleId, groupId, cond.field, cond.operator, JSON.stringify(cond.value)],
        );
      }
    }
    for (const [si, serviceId] of input.actionServiceIds.entries()) {
      await db.query(
        `INSERT INTO rule_action_service (rule_id, service_id, position)
         VALUES ($1, $2, $3)`,
        [ruleId, serviceId, si + 1],
      );
    }
  }

  async create(shopId: string, memberId: string, input: RuleInput): Promise<RuleView> {
    this.validateConditions(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertServicesExist(client, input.actionServiceIds);
      await this.assertSavedZone(client, shopId, input);
      // New rules append to the bottom of the priority list (§9.4.1).
      const { rows: pos } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM rule WHERE shop_id = $1`,
        [shopId],
      );
      const { rows } = await client.query<{ rule_id: string }>(
        `INSERT INTO rule
           (shop_id, name, is_active, position, action_type, excluded_service_ids,
            active_from, active_to)
         VALUES ($1, $2, true, $3, $4, $5, $6, $7)
         RETURNING rule_id`,
        [
          shopId,
          input.name,
          pos[0].next,
          input.actionType,
          input.excludedServiceIds ?? [],
          input.activeFrom ?? null,
          input.activeTo ?? null,
        ],
      );
      const ruleId = rows[0].rule_id;
      await this.insertChildren(client, ruleId, input);
      await client.query('COMMIT');
      const view = await this.get(shopId, ruleId);
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: memberId,
        action: 'rule.create',
        objectType: 'rule',
        objectId: ruleId,
        after: view,
      });
      return view;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async update(
    shopId: string,
    memberId: string,
    ruleId: string,
    input: UpdateRuleInput,
  ): Promise<RuleView> {
    this.validateConditions(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await this.get(shopId, ruleId);
      await this.assertServicesExist(client, input.actionServiceIds);
      await this.assertSavedZone(client, shopId, input);
      // INV-22: the write carries the version the writer read.
      const { rowCount } = await client.query(
        `UPDATE rule
            SET name = $3, action_type = $4, excluded_service_ids = $5,
                active_from = $6, active_to = $7, version = version + 1
          WHERE shop_id = $1 AND rule_id = $2 AND version = $8`,
        [
          shopId,
          ruleId,
          input.name,
          input.actionType,
          input.excludedServiceIds ?? [],
          input.activeFrom ?? null,
          input.activeTo ?? null,
          input.version,
        ],
      );
      if (rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          current: before,
        });
      }
      await client.query(`DELETE FROM rule_condition WHERE rule_id = $1`, [ruleId]);
      await client.query(`DELETE FROM rule_condition_group WHERE rule_id = $1`, [ruleId]);
      await client.query(`DELETE FROM rule_action_service WHERE rule_id = $1`, [ruleId]);
      await this.insertChildren(client, ruleId, input);
      await client.query('COMMIT');
      const after = await this.get(shopId, ruleId);
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: memberId,
        action: 'rule.edit',
        objectType: 'rule',
        objectId: ruleId,
        before,
        after,
      });
      return after;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async setActive(
    shopId: string,
    memberId: string,
    ruleId: string,
    active: boolean,
    version: number,
  ): Promise<RuleView> {
    const { rowCount } = await this.pool.query(
      `UPDATE rule SET is_active = $3, version = version + 1
        WHERE shop_id = $1 AND rule_id = $2 AND version = $4`,
      [shopId, ruleId, active, version],
    );
    if (rowCount !== 1) {
      const current = await this.get(shopId, ruleId); // 404 when absent (INV-1)
      throw new ConflictException({ code: 'VERSION_CONFLICT', current });
    }
    const after = await this.get(shopId, ruleId);
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: active ? 'rule.activate' : 'rule.deactivate',
      objectType: 'rule',
      objectId: ruleId,
      after: { isActive: active },
    });
    return after;
  }

  /** §9.4.1 priority ordering. The body must name EVERY rule of the shop
   *  exactly once — a partial reorder is never applied silently (INV-20). */
  async reorder(shopId: string, memberId: string, ruleIds: string[]): Promise<RuleView[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ rule_id: string }>(
        `SELECT rule_id FROM rule WHERE shop_id = $1`,
        [shopId],
      );
      const existing = new Set(rows.map((r) => r.rule_id));
      const supplied = new Set(ruleIds);
      if (
        existing.size !== supplied.size ||
        [...existing].some((id) => !supplied.has(id))
      ) {
        throw new BadRequestException('reorder must list every rule of the shop exactly once');
      }
      for (const [i, ruleId] of ruleIds.entries()) {
        await client.query(
          `UPDATE rule SET position = $3, version = version + 1
            WHERE shop_id = $1 AND rule_id = $2`,
          [shopId, ruleId, i + 1],
        );
      }
      await client.query('COMMIT');
      const after = await this.list(shopId);
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: memberId,
        action: 'rule.reorder',
        objectType: 'rule',
        objectId: null,
        after: { order: ruleIds },
      });
      return after;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** §5.3: hard delete only while unused — a rule referenced by any
   *  rule_evaluation_trace is deactivated, never deleted. */
  async remove(shopId: string, memberId: string, ruleId: string): Promise<void> {
    const before = await this.get(shopId, ruleId); // 404 + INV-1
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rule_evaluation_trace
        WHERE shop_id = $1 AND rule_id = $2`,
      [shopId, ruleId],
    );
    if ((rows[0]?.n ?? 0) > 0) {
      throw new ConflictException(
        'rule is referenced by evaluation traces — deactivate it instead (§5.3)',
      );
    }
    const { rowCount } = await this.pool.query(
      `DELETE FROM rule WHERE shop_id = $1 AND rule_id = $2`,
      [shopId, ruleId],
    );
    if (rowCount !== 1) throw new NotFoundException('rule not found');
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'rule.delete',
      objectType: 'rule',
      objectId: ruleId,
      before,
    });
  }
}
