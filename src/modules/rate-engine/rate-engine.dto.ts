import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { COMPONENT_BASES, ZONE_CODES, type ComponentBasis, type RtoBasis, type ZoneCode } from './pricing';
import type { payment_mode } from '../courier-framework/adapter.enum-types';

/**
 * DTOs for the rate-engine endpoints (§9.15). Numeric money/weight/rate
 * fields are STRINGS at the boundary (§4.1 — no floats for money, ever);
 * shapes are validated here, ranges at the service/DB layer. Every write
 * carries the INV-22 `version` the writer read.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE = /^\d+(?:\.\d{1,2})?$/; // 2dp paise-safe
const WEIGHT_RE = /^\d+(?:\.\d{1,3})?$/; // kg 3dp
const DIM_RE = /^\d+(?:\.\d{1,2})?$/; // cm 2dp
const RATE_RE = /^\d+(?:\.\d{1,6})?$/; // 0–1 stored, 6dp
const PERCENT_VALUE_RE = /^\d+(?:\.\d{1,6})?$/; // component value: money or rate

export class CreateRateCardDto {
  @IsUUID()
  serviceId!: string;

  @IsUUID()
  courierAccountId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class SlabDto {
  @IsIn(ZONE_CODES)
  zone!: ZoneCode;

  @Matches(WEIGHT_RE)
  baseWeightKg!: string;

  @Matches(MONEY_RE)
  baseRate!: string;

  @Matches(WEIGHT_RE)
  additionalStepKg!: string;

  @Matches(MONEY_RE)
  additionalRate!: string;
}

export class ComponentDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsIn(COMPONENT_BASES)
  basis!: ComponentBasis;

  /** Money 2dp for FLAT / PER_KG_BILLABLE; rate 0–1 6dp for percent bases. */
  @Matches(PERCENT_VALUE_RE)
  value!: string;

  @IsBoolean()
  isTaxable!: boolean;

  @IsInt()
  @Min(0)
  position!: number;
}

export class CreateRateCardVersionDto {
  @Matches(DATE_RE)
  effectiveFrom!: string;

  @IsOptional()
  @Matches(DATE_RE)
  effectiveTo?: string | null;

  @IsUUID()
  zoneMapId!: string;

  @Matches(RATE_RE)
  fuelPct!: string;

  @Matches(MONEY_RE)
  codFlat!: string;

  @Matches(RATE_RE)
  codPct!: string;

  @IsIn(['SAME_AS_FORWARD', 'PERCENT_OF_FORWARD'])
  rtoBasis!: RtoBasis;

  @IsOptional()
  @Matches(RATE_RE)
  rtoPct?: string | null;

  @Matches(RATE_RE)
  gstPct!: string;

  @IsArray()
  @IsString({ each: true })
  taxableComponents!: string[];

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SlabDto)
  slabs!: SlabDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComponentDto)
  components!: ComponentDto[];

  /** INV-22: the rate_card.version the writer read. */
  @IsInt()
  @Min(1)
  rateCardVersion!: number;
}

export class SealDto {
  /** INV-22: the version the writer read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class ZoneRuleDto {
  /** F-4 matcher JSON (§4.3) — shape-validated in the service. */
  @IsNotEmpty()
  originMatcher!: Record<string, unknown>;

  @IsNotEmpty()
  destinationMatcher!: Record<string, unknown>;

  @IsIn(ZONE_CODES)
  zone!: ZoneCode;

  @IsInt()
  @Min(0)
  position!: number;
}

export class CreateZoneMapDto {
  @IsUUID()
  serviceId!: string;

  @IsString()
  @IsNotEmpty()
  label!: string;

  @Matches(DATE_RE)
  effectiveFrom!: string;

  /** The frozen postal master reference (A1-05). */
  @IsUUID()
  postalVersionId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ZoneRuleDto)
  rules!: ZoneRuleDto[];
}

export class EstimateCostDto {
  @IsUUID()
  serviceId!: string;

  @Matches(/^[0-9]{6}$/)
  destinationPincode!: string;

  /** F-24 dead weight, 3dp kg. */
  @Matches(WEIGHT_RE)
  deadWeightKg!: string;

  @Matches(DIM_RE)
  lengthCm!: string;

  @Matches(DIM_RE)
  widthCm!: string;

  @Matches(DIM_RE)
  heightCm!: string;

  @IsIn(['PREPAID', 'COD', 'UNRESOLVED'])
  paymentMode!: payment_mode;

  /** 2dp; '0.00' for prepaid. */
  @Matches(MONEY_RE)
  collectible!: string;

  /** 2dp; the ADD-41 insurance basis. */
  @Matches(MONEY_RE)
  declaredValue!: string;

  @Matches(DATE_RE)
  shipDate!: string;
}

export class CsvValidateDto {
  /** Raw CSV text (§9.15 template); limits enforced at validation (§5.1). */
  @IsString()
  csv!: string;
}

export class CsvConfirmDto extends CsvValidateDto {
  @Matches(DATE_RE)
  effectiveFrom!: string;

  @IsOptional()
  @Matches(DATE_RE)
  effectiveTo?: string | null;

  @IsUUID()
  zoneMapId!: string;

  @Matches(RATE_RE)
  fuelPct!: string;

  @Matches(MONEY_RE)
  codFlat!: string;

  @Matches(RATE_RE)
  codPct!: string;

  @IsIn(['SAME_AS_FORWARD', 'PERCENT_OF_FORWARD'])
  rtoBasis!: RtoBasis;

  @IsOptional()
  @Matches(RATE_RE)
  rtoPct?: string | null;

  @Matches(RATE_RE)
  gstPct!: string;

  @IsArray()
  @IsString({ each: true })
  taxableComponents!: string[];

  /** INV-22: the rate_card.version the writer read. */
  @IsInt()
  @Min(1)
  rateCardVersion!: number;
}
