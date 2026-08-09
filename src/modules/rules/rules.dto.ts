import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  ConditionValue,
  RuleActionType,
  RuleConditionField,
  RuleOperator,
} from './evaluate';

/**
 * DTOs for the rules endpoints (§9.4). Numeric money/weight fields are
 * STRINGS at the boundary (§4.1 — no floats for money, ever); every write
 * carries the INV-22 `version` the writer read. Field/operator compatibility
 * is validated in RulesService against §3.9 + ADD-01…ADD-12.
 */

const ACTIONS: RuleActionType[] = ['PRIORITY_CHAIN', 'CHEAPEST', 'FASTEST', 'MANUAL_ONLY'];
const FIELDS: RuleConditionField[] = [
  'WEIGHT', 'ORDER_AMOUNT', 'PAYMENT_MODE', 'PINCODE', 'SKU', 'TAG',
  'DEST_STATE', 'DEST_CITY', 'ZONE', 'COD_AMOUNT', 'ESTIMATED_FREIGHT',
  'CHECKOUT_SHIPPING_TITLE', 'CHECKOUT_SHIPPING_AMOUNT', 'ITEM_COUNT',
  'PRODUCT', 'VENDOR', 'COLLECTION', 'VOLUMETRIC_WEIGHT', 'RISK_FLAG',
  'WEEKDAY', 'TIME_OF_DAY',
];
const OPERATORS: RuleOperator[] = [
  'EQUALS', 'BETWEEN', 'GTE', 'LTE', 'IN_LIST', 'NOT_IN_LIST',
  'IN_SAVED_ZONE', 'CSV_UPLOAD', 'IS_COD', 'IS_PREPAID', 'CONTAINS',
  'IS_HIGH', 'IS_NOT_HIGH',
];

export class ConditionValueDto implements ConditionValue {
  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  @IsString()
  min?: string;

  @IsOptional()
  @IsString()
  max?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  list?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pincodes?: string[];

  @IsOptional()
  @IsUUID()
  zoneId?: string;
}

export class ConditionDto {
  @IsIn(FIELDS)
  field!: RuleConditionField;

  @IsIn(OPERATORS)
  operator!: RuleOperator;

  @ValidateNested()
  @Type(() => ConditionValueDto)
  value!: ConditionValueDto;
}

export class ConditionGroupDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions!: ConditionDto[];
}

export class CreateRuleDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(ACTIONS)
  actionType!: RuleActionType;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  excludedServiceIds?: string[]; // ADD-15

  @IsOptional()
  @IsISO8601()
  activeFrom?: string; // ADD-16

  @IsOptional()
  @IsISO8601()
  activeTo?: string; // ADD-16

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ConditionGroupDto)
  groups!: ConditionGroupDto[];

  @IsArray()
  @IsUUID(undefined, { each: true })
  actionServiceIds!: string[];
}

export class UpdateRuleDto extends CreateRuleDto {
  /** INV-22. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class SetActiveDto {
  @IsBoolean()
  active!: boolean;

  /** INV-22. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class ReorderDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  ruleIds!: string[];
}

export class CreateZoneDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pincodes?: string[];

  /** §9.4.2 CSV upload (bounded by §5.1, normalized 6-digit). */
  @IsOptional()
  @IsString()
  csv?: string;
}

export class UpdateZoneDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pincodes?: string[];

  @IsOptional()
  @IsString()
  csv?: string;

  /** INV-22. */
  @IsInt()
  @Min(1)
  version!: number;
}

const DECIMAL_RE = /^\d+(?:\.\d{1,4})?$/;
const WEIGHT_RE = /^\d+(?:\.\d{1,3})?$/;
const DIM_RE = /^\d+(?:\.\d{1,2})?$/;

/** §9.4.6 simulator: a hand-made sample order. */
export class SimulateDto {
  @Matches(/^[0-9]{6}$/)
  destinationPincode!: string;

  @Matches(WEIGHT_RE)
  deadWeightKg!: string;

  @IsOptional()
  @Matches(DIM_RE)
  lengthCm?: string;

  @IsOptional()
  @Matches(DIM_RE)
  widthCm?: string;

  @IsOptional()
  @Matches(DIM_RE)
  heightCm?: string;

  @IsIn(['PREPAID', 'COD'])
  paymentMode!: 'PREPAID' | 'COD';

  @IsOptional()
  @Matches(DECIMAL_RE)
  collectible?: string;

  @IsOptional()
  @Matches(DECIMAL_RE)
  orderAmount?: string;

  @IsOptional()
  @Matches(DECIMAL_RE)
  codAmount?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skus?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  checkoutShippingTitle?: string;

  @IsOptional()
  @Matches(DECIMAL_RE)
  checkoutShippingAmount?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  itemCount?: number;

  @IsOptional()
  @IsString()
  riskFlag?: string;
}

/** ADD-17 test-fire: the last N real orders, default 100. */
export class TestFireDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  count?: number;
}
