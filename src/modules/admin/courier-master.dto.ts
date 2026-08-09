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
  IsUrl,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** §3.31 value lists (PG enums in migration 0006) transcribed for validation. */
export const COURIER_KINDS = ['DIRECT', 'AGGREGATOR'] as const;
export const COURIER_AUTH_PATTERNS = ['KEY_PASTE', 'OAUTH'] as const;
export const SERVICE_LABEL_MODES = ['COURIER_PDF_REQUIRED', 'CUSTOM_ALLOWED'] as const;
export const COST_SOURCES = ['RATE_CARD', 'LIVE_QUOTE', 'NONE'] as const;

/** §3.6 CARRIER_EVENT_STATUS — the only mapping target (A2-06). */
export const CARRIER_EVENT_STATUSES = [
  'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
  'DELIVERED', 'UNDELIVERED_ATTEMPT', 'RTO_INITIATED', 'RTO_IN_TRANSIT',
  'RTO_OUT_FOR_DELIVERY', 'RTO_DELIVERED', 'LOST_OR_DAMAGED',
  'CANCELLED_BY_COURIER',
] as const;

export class CreateCourierDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @MaxLength(64)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsIn(COURIER_KINDS as unknown as string[])
  kind!: string;

  @IsIn(COURIER_AUTH_PATTERNS as unknown as string[])
  authPattern!: string;
}

export class UpdateCourierDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** A1-12 / §5.7 control 3: is_secret fields are write-only, masked on display. */
export class CredentialFieldDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @MaxLength(64)
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  type?: string;

  @IsOptional()
  @IsBoolean()
  isSecret?: boolean;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  validationRegex?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class SetCredentialFieldsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CredentialFieldDto)
  fields!: CredentialFieldDto[];
}

export class CreateServiceDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @MaxLength(64)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsIn(SERVICE_LABEL_MODES as unknown as string[])
  labelMode!: string;

  @IsIn(COST_SOURCES as unknown as string[])
  costSource!: string;
}

export class UpdateServiceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** §4.2–§4.4 versioned divisor / minimum / increment. Strings, never floats (§4.1). */
export class CreateServiceVersionDto {
  @IsISO8601()
  effectiveFrom!: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,4})?$/)
  volumetricDivisor?: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,3})?$/)
  minBillableKg?: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,3})?$/)
  billableIncrementKg?: string;

  @IsOptional()
  @IsBoolean()
  supportsCod?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsReverse?: boolean;
}

export class StatusMapEntryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  rawStatus!: string;

  @IsIn(CARRIER_EVENT_STATUSES as unknown as string[])
  carrierEventStatus!: string;
}

export class SetStatusMapDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => StatusMapEntryDto)
  entries!: StatusMapEntryDto[];
}

/** §9.13 guides manager: video + doc + PDF per courier, live instantly. */
export class UpsertCourierGuideDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  videoUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  docUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  pdfObjectKey?: string;

  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}
