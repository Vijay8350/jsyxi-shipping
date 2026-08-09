import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { CreatePlanDto, UpdatePlanDto } from './plan-admin.dto';
import { AdminContext } from './admin.types';

/**
 * §9.13 plan/tier management (§10.3: PLATFORM_ADMIN and PLATFORM_FINANCE).
 * This manages the plan table ROWS only — every actual charge is Shopify
 * Billing API semantics (§9.14, INV-23) owned by the sibling billing module;
 * nothing here creates or touches a Shopify subscription.
 *
 * plan is [global] reference data (migration 0002). Prices are decimal
 * strings end-to-end (§4.1 — no floats for money).
 */
@Injectable()
export class PlanAdminService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async listPlans(): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT plan_id, code, name, awb_allowance_per_cycle,
              price::text AS price, currency, overage_unit_price::text AS overage_unit_price,
              is_trial, is_active, version, created_at, updated_at
         FROM plan
        ORDER BY price ASC, code ASC`,
    );
    return rows;
  }

  async createPlan(actor: AdminContext, dto: CreatePlanDto): Promise<{ planId: string }> {
    try {
      const { rows } = await this.pool.query<{ plan_id: string }>(
        `INSERT INTO plan
           (code, name, awb_allowance_per_cycle, price, currency, overage_unit_price, is_trial)
         VALUES ($1, $2, $3, $4::numeric, $5, $6::numeric, $7)
         RETURNING plan_id`,
        [
          dto.code,
          dto.name,
          dto.awbAllowancePerCycle,
          dto.price,
          dto.currency ?? 'INR',
          dto.overageUnitPrice,
          dto.isTrial ?? false,
        ],
      );
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: actor.adminId,
        action: 'admin_plan.created',
        objectType: 'plan',
        objectId: rows[0].plan_id,
        after: {
          code: dto.code,
          name: dto.name,
          awb_allowance_per_cycle: dto.awbAllowancePerCycle,
          price: dto.price,
          currency: dto.currency ?? 'INR',
          overage_unit_price: dto.overageUnitPrice,
          is_trial: dto.isTrial ?? false,
        },
      });
      return { planId: rows[0].plan_id };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('plan code already exists');
      throw err;
    }
  }

  async updatePlan(actor: AdminContext, planId: string, dto: UpdatePlanDto): Promise<void> {
    const before = await this.pool.query(
      `SELECT code, name, awb_allowance_per_cycle, price::text AS price,
              overage_unit_price::text AS overage_unit_price, is_trial, is_active
         FROM plan WHERE plan_id = $1`,
      [planId],
    );
    if (before.rows.length === 0) throw new NotFoundException('plan not found');
    await this.pool.query(
      `UPDATE plan
          SET name = COALESCE($2, name),
              awb_allowance_per_cycle = COALESCE($3, awb_allowance_per_cycle),
              price = COALESCE($4::numeric, price),
              overage_unit_price = COALESCE($5::numeric, overage_unit_price),
              is_trial = COALESCE($6, is_trial),
              is_active = COALESCE($7, is_active),
              version = version + 1
        WHERE plan_id = $1`,
      [
        planId,
        dto.name ?? null,
        dto.awbAllowancePerCycle ?? null,
        dto.price ?? null,
        dto.overageUnitPrice ?? null,
        dto.isTrial ?? null,
        dto.isActive ?? null,
      ],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_plan.updated',
      objectType: 'plan',
      objectId: planId,
      before: before.rows[0],
      after: {
        name: dto.name,
        awb_allowance_per_cycle: dto.awbAllowancePerCycle,
        price: dto.price,
        overage_unit_price: dto.overageUnitPrice,
        is_trial: dto.isTrial,
        is_active: dto.isActive,
      },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
