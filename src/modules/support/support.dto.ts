import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_TYPES,
  AnnouncementAudience,
  AnnouncementType,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_FILES,
  TICKET_CATEGORIES,
  TICKET_MESSAGE_MAX_CHARS,
  TICKET_PRIORITIES,
  TICKET_STATES,
  TicketCategory,
  TicketPriority,
  TicketState,
} from './support.types';

/**
 * DTOs for the support endpoints (§9.18, §9.19). Attachments travel as
 * object references — {key, bytes} against the shop-prefixed object store
 * (INV-1: keys are `shops/{shop_id}/...`); the binary upload itself is the
 * booking-ops ObjectStore's signed-URL flow, a binding point for the parent.
 * Here we enforce only the §5.1 envelope: ≤5 files × 10 MB per ticket
 * message, 1 PNG/JPEG ≤ 10 MB for feedback.
 *
 * Every admin write to a ticket carries the INV-22 `version` the writer read;
 * a mismatch is a 409 with the current state (§6).
 */

export class AttachmentRefDto {
  /** Shop-prefixed object key (INV-1). */
  @IsString()
  @IsNotEmpty()
  key!: string;

  /** Declared size; the §5.1 10 MB ceiling is enforced on it. */
  @IsInt()
  @Min(1)
  @Max(TICKET_ATTACHMENT_MAX_BYTES)
  bytes!: number;
}

export class CreateTicketDto {
  @IsIn(TICKET_CATEGORIES)
  category!: TicketCategory;

  /** §3.16 default NORMAL (RW-17) applies when omitted. */
  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  subject!: string;

  /** Becomes the first ticket_message (author MEMBER). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(TICKET_MESSAGE_MAX_CHARS)
  description!: string;

  /** §5.1: 5 files × 10 MB. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TICKET_ATTACHMENT_MAX_FILES)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];

  /** Optional linked Order — must exist in this Shop (INV-1). */
  @IsOptional()
  @IsUUID()
  linkedOrderId?: string;

  /** Optional linked AWB — normalized (F-19) and must resolve in this Shop. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  linkedAwb?: string;
}

export class TicketReplyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(TICKET_MESSAGE_MAX_CHARS)
  body!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TICKET_ATTACHMENT_MAX_FILES)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];
}

export class AssignTicketDto {
  @IsUUID()
  assignedAdminId!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class TransitionTicketDto {
  /** Target state; the §3.16 machine decides legality. */
  @IsIn(TICKET_STATES)
  to!: TicketState;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ComposeAnnouncementDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(TICKET_MESSAGE_MAX_CHARS)
  body!: string;

  /** §3.31; only WARNING emails Members on publish (A2-09). */
  @IsIn(ANNOUNCEMENT_TYPES)
  type!: AnnouncementType;

  /** §3.29. ALL ⇒ audienceRef MUST be null (mirrors the §2 CHECK). */
  @IsIn(ANNOUNCEMENT_AUDIENCES)
  audienceKind!: AnnouncementAudience;

  /**
   * §3.29 audience_ref shape: BY_PLAN → {planCode: string};
   * SPECIFIC_SHOPS → {shopIds: string[]}. Validated in the service so the
   * null-for-ALL CHECK and the per-kind shapes fail as 400, never as 500.
   */
  @IsOptional()
  audienceRef?: unknown;
}

export class SubmitFeedbackDto {
  /** §9.19: 1–5 rating. */
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(TICKET_MESSAGE_MAX_CHARS)
  comment?: string;

  /**
   * §5.1: 1 PNG/JPEG ≤ 10 MB. Extension and declared size are validated in
   * the service (the key's extension is the only type signal available here).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => AttachmentRefDto)
  screenshot?: AttachmentRefDto;
}
