import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { CourierAccountMode } from './vault.service';

/** DTOs for the courier account endpoints (§9.3.3, ADD-18). Credential
 *  values arrive write-only in the body and are never echoed back (§5.7
 *  control 3, INV-18). */

export class ConnectAccountDto {
  @IsUUID()
  courierId!: string;

  /** Defaults to TEST (§9.3.3). */
  @IsOptional()
  @IsIn(['TEST', 'LIVE'])
  mode?: CourierAccountMode;

  @IsObject()
  credentials!: Record<string, unknown>;
}

export class SwitchModeDto {
  @IsIn(['TEST', 'LIVE'])
  mode!: CourierAccountMode;
}

export class ReplaceCredentialsDto {
  @IsObject()
  credentials!: Record<string, unknown>;
}

export class SetEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

export class SetMerchantServiceDto {
  @IsUUID()
  serviceId!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  priorityTiebreakOrder?: number;
}

export class CourierRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  courierNameText!: string;
}
