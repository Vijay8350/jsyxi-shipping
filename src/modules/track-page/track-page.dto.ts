import {
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** PATCH body for track-page config — INV-22 version is mandatory. */
export class UpdateTrackPageConfigDto {
  @IsInt()
  @Min(1)
  version!: number;

  /** S-31 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  orderBoxLabel?: string;

  /** S-32 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  contactBoxLabel?: string;

  /** S-33 */
  @IsOptional()
  @IsIn(['light', 'dark'])
  theme?: 'light' | 'dark';

  /** S-34 */
  @IsOptional()
  @IsHexColor()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  buttonColour?: string;

  /** S-35 */
  @IsOptional()
  @IsBoolean()
  showCourierName?: boolean;

  /** S-36 */
  @IsOptional()
  @IsBoolean()
  showItemSummary?: boolean;

  /** S-37 */
  @IsOptional()
  @IsBoolean()
  replaceTrackingLink?: boolean;

  /** S-49 — null restores the inherited brand logo. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(512)
  logoObjectKey?: string | null;
}

/** POST /track/lookup body (§9.16 manual lookup path). */
export class TrackLookupDto {
  /** The shop public ref from the hosted-page URL — never the shop_id. */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-f]{12}$/)
  shopRef!: string;

  /** Order ID or AWB (S-31 box). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  identifier!: string;

  /** Full normalized email or phone used on the order (S-32 box). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  contact!: string;

  /** Required once S-38's CAPTCHA gate trips (5 consecutive failures). */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  captchaToken?: string;
}
