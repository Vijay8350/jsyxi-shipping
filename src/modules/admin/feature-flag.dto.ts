import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export const FEATURE_FLAG_SCOPES = ['GLOBAL', 'SHOP'] as const;

export class UpsertFeatureFlagDto {
  @IsString()
  @Matches(/^[a-z0-9_.-]+$/)
  @MaxLength(128)
  key!: string;

  @IsIn(FEATURE_FLAG_SCOPES as unknown as string[])
  scope!: string;

  /** Required iff scope = SHOP; must be absent for GLOBAL. */
  @IsOptional()
  @IsUUID()
  shopId?: string;

  @IsBoolean()
  enabled!: boolean;
}
