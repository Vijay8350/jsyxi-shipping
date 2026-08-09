import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SUPPORT_CONTEXT_MAX_MINUTES } from './admin.constants';

/** A1-07: reason- or ticket-bound; the service enforces at least one. */
export class OpenSupportContextDto {
  @IsUUID()
  shopId!: string;

  @IsOptional()
  @IsUUID()
  ticketId?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;

  /** ≤ 60 minutes (§10.3 time box); the service clamps to the ceiling. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SUPPORT_CONTEXT_MAX_MINUTES)
  ttlMinutes?: number;
}
