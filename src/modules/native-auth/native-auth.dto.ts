import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PASSWORD_MIN_LENGTH } from './native-auth.constants';

/** OVR-1 roles an Owner may grant to a native member — never OWNER. */
const INVITABLE_ROLES = ['OPERATOR', 'FINANCE', 'VIEWER'] as const;

export class CreateInviteDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  // OVR-1: a native member can never become Owner; the DB CHECK
  // (member_invite.role <> 'OWNER') backs this validation.
  @IsIn(INVITABLE_ROLES as unknown as string[])
  role!: string;
}

export class AcceptInviteDto {
  @IsString()
  @MinLength(1)
  token!: string;

  // NOTE: the OVR-1 task brief sketched {token, password, totpCode} here, but
  // a TOTP code cannot exist before enrollment, and enrollment needs a
  // session — so accept issues the session and enrollment follows. Login
  // stays blocked until totp_confirmed (mandatory 2FA).
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  password!: string;
}

export class TotpConfirmDto {
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

/** Login is shop-scoped (INV-1): the login page passes its shop. */
export class NativeLoginDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shopDomain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  shopId?: string;
}

export class MagicLinkRequestDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shopDomain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  shopId?: string;
}

export class TokenConsumeDto {
  @IsString()
  @MinLength(1)
  token!: string;
}

export class PasswordResetRequestDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shopDomain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  shopId?: string;
}

export class PasswordResetConsumeDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  newPassword!: string;
}
