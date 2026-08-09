import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * §4.1: money is NUMERIC(19,4) — DTOs carry decimal STRINGS, never floats.
 * INV-23: there is no margin field on a plan and none is accepted here.
 */
const MONEY = /^\d+(\.\d{1,4})?$/;

export class CreatePlanDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @MaxLength(64)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(0)
  awbAllowancePerCycle!: number;

  @Matches(MONEY)
  price!: string;

  @IsOptional()
  @IsIn(['INR']) // INV-2: INR only at v1
  currency?: string;

  @Matches(MONEY)
  overageUnitPrice!: string;

  @IsOptional()
  @IsBoolean()
  isTrial?: boolean;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  awbAllowancePerCycle?: number;

  @IsOptional()
  @Matches(MONEY)
  price?: string;

  @IsOptional()
  @Matches(MONEY)
  overageUnitPrice?: string;

  @IsOptional()
  @IsBoolean()
  isTrial?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
