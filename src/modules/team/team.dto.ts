import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { MemberRole } from '../../auth/session.types';
import { NON_OWNER_ROLES } from './team.types';

/**
 * DTOs for the Team & Roles and access-request endpoints (§9.1.2).
 * Every write carries the INV-22 `version` the writer read; a mismatch is a
 * 409 with the current state, never a silent last-write-wins (§6 INV-22).
 * OWNER is never a grantable role here — a native member can never be Owner
 * and ownership moves only via transfer or claim (OVR-1, §9.1.2).
 */

export class GrantRoleDto {
  /** The Shopify staff user the entry layer already identified (§9.1.1). */
  @IsString()
  @IsNotEmpty()
  shopifyStaffUserId!: string;

  @IsIn(NON_OWNER_ROLES)
  role!: MemberRole;

  /** Required only when reviving a previously revoked member row (INV-22). */
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class ChangeRoleDto {
  @IsIn(NON_OWNER_ROLES)
  role!: MemberRole;

  @IsInt()
  @Min(1)
  version!: number;
}

export class RevokeMemberDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class TransferOwnershipDto {
  @IsUUID()
  targetMemberId!: string;

  /**
   * The role the current Owner takes after the transfer. §9.1.2 does not fix
   * the demotion role, so the request must name it explicitly; it may not be
   * OWNER (that would leave two Owners, violating §9.1.2 / the
   * shop_member_one_owner index).
   */
  @IsIn(NON_OWNER_ROLES)
  ownerNewRole!: MemberRole;

  /** INV-22 version the requester read on their own (current Owner) row. */
  @IsInt()
  @Min(1)
  ownerVersion!: number;

  /** INV-22 version the requester read on the target member row. */
  @IsInt()
  @Min(1)
  targetVersion!: number;
}

export class GrantAccessRequestDto {
  @IsIn(NON_OWNER_ROLES)
  role!: MemberRole;

  @IsInt()
  @Min(1)
  version!: number;
}

export class DenyAccessRequestDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class WithdrawAccessRequestDto {
  @IsInt()
  @Min(1)
  version!: number;
}

/** Body for the internal (shopify entry module → this module) create call. */
export class InternalCreateAccessRequestDto {
  @IsString()
  @IsNotEmpty()
  shopifyStaffUserId!: string;
}

/** Body for the internal withdraw call (entry layer supplies the identity it verified). */
export class InternalWithdrawAccessRequestDto {
  @IsString()
  @IsNotEmpty()
  shopifyStaffUserId!: string;

  @IsInt()
  @Min(1)
  version!: number;
}
