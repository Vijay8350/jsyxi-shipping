import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RolesGuard } from '../team/rbac/roles.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RulesService } from './rules.service';
import { RuleSimulatorService, type SimulateInput } from './rule-simulator.service';
import {
  CreateRuleDto,
  ReorderDto,
  SetActiveDto,
  SimulateDto,
  TestFireDto,
  UpdateRuleDto,
} from './rules.dto';

/**
 * Shipping rules endpoints (§9.4). SessionGuard establishes identity (INV-1)
 * on every route. Writes require 'rules.edit' (§10.2 "Create / edit rules,
 * saved zones" — Operator+); reads are open to every role (Viewer is R on
 * the same row). The simulator and ADD-17 test-fire require 'rules.simulate'
 * (§10.2 "Run the rule simulator" — Owner/Operator/Finance run; both
 * endpoints are read-only and book nothing).
 */
@Controller('rules')
@UseGuards(SessionGuard)
export class RulesController {
  constructor(
    private readonly rules: RulesService,
    private readonly simulator: RuleSimulatorService,
  ) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.rules.list(req.session.shopId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateRuleDto) {
    return this.rules.create(req.session.shopId, req.session.memberId, dto);
  }

  /** §9.4.6: hand-made sample order → the full trace; nothing persisted. */
  @Post('simulate')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.simulate')
  simulate(@Req() req: AuthenticatedRequest, @Body() dto: SimulateDto) {
    const sample: SimulateInput = {
      destinationPincode: dto.destinationPincode,
      deadWeightKg: dto.deadWeightKg,
      lengthCm: dto.lengthCm ?? '0.00',
      widthCm: dto.widthCm ?? '0.00',
      heightCm: dto.heightCm ?? '0.00',
      paymentMode: dto.paymentMode,
      collectible: dto.collectible ?? '0.00',
      orderAmount: dto.orderAmount ?? null,
      codAmount: dto.codAmount ?? null,
      skus: dto.skus ?? [],
      tags: dto.tags ?? [],
      checkoutShippingTitle: dto.checkoutShippingTitle ?? null,
      checkoutShippingAmount: dto.checkoutShippingAmount ?? null,
      itemCount: dto.itemCount ?? null,
      riskFlag: dto.riskFlag ?? null,
    };
    return this.simulator.simulate(req.session.shopId, sample);
  }

  /** ADD-17: last N real orders (default 100, test excluded), read-only. */
  @Post('test-fire')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.simulate')
  testFire(@Req() req: AuthenticatedRequest, @Body() dto: TestFireDto) {
    return this.simulator.testFire(req.session.shopId, dto.count ?? 100);
  }

  @Post('reorder')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  reorder(@Req() req: AuthenticatedRequest, @Body() dto: ReorderDto) {
    return this.rules.reorder(req.session.shopId, req.session.memberId, dto.ruleIds);
  }

  @Get(':ruleId')
  get(@Req() req: AuthenticatedRequest, @Param('ruleId', ParseUUIDPipe) ruleId: string) {
    return this.rules.get(req.session.shopId, ruleId);
  }

  @Put(':ruleId')
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: UpdateRuleDto,
  ) {
    return this.rules.update(req.session.shopId, req.session.memberId, ruleId, dto);
  }

  @Post(':ruleId/active')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  setActive(
    @Req() req: AuthenticatedRequest,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: SetActiveDto,
  ) {
    return this.rules.setActive(
      req.session.shopId,
      req.session.memberId,
      ruleId,
      dto.active,
      dto.version,
    );
  }

  @Delete(':ruleId')
  @UseGuards(RolesGuard)
  @RequiresPermission('rules.edit')
  remove(@Req() req: AuthenticatedRequest, @Param('ruleId', ParseUUIDPipe) ruleId: string) {
    return this.rules.remove(req.session.shopId, req.session.memberId, ruleId);
  }
}
