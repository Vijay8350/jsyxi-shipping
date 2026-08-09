import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

/** ADD-33: surface_key is a stable screen identifier like 'rules' or 'rate_cards'. */
export class UpsertScreenGuideDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  videoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  docText?: string;
}

export const SURFACE_KEY_PATTERN = /^[a-z0-9_]+$/;

export function isValidSurfaceKey(key: string): boolean {
  return SURFACE_KEY_PATTERN.test(key) && key.length <= 64;
}
