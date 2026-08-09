import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  IsOptional,
} from 'class-validator';
import { ALL_ADMIN_ROLES } from './admin.types';
import { ADMIN_PASSWORD_MIN_LENGTH } from './admin.constants';

export class CreateAdminUserDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(ADMIN_PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  password!: string;

  // §10.3: exactly the three admin roles; nothing else exists.
  @IsIn(ALL_ADMIN_ROLES as unknown as string[])
  role!: string;
}

export class AdminLoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totpCode?: string;
}

/** Pre-session TOTP enrollment is password-gated (§10.3 mandatory MFA). */
export class AdminTotpEnrollDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

export class AdminTotpConfirmDto extends AdminTotpEnrollDto {
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
