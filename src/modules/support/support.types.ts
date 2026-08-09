/**
 * Shared types and constants for the support module (spec.md §9.18 tickets,
 * §9.19 announcements & feedback; schema in migration 0017). Value lists are
 * transcribed verbatim from §3.16, §3.29 and §3.31 (RW-17) — the enum types
 * in migration 0017 are the database authority, these are the code mirror.
 */

/** §3.16 TICKET_STATE — CLOSED is terminal: "CLOSED requires a new ticket". */
export const TICKET_STATES = [
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

/** §3.16 TICKET_CATEGORY — "the brief's five categories" (RW-17). */
export const TICKET_CATEGORIES = [
  'COURIER_ISSUE',
  'BILLING',
  'BUG',
  'FEATURE',
  'OTHER',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** §3.16 TICKET_PRIORITY — default NORMAL (RW-17). */
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/**
 * §3.16 transitions. §3.16 fixes the value list and two rules only — reopen
 * of RESOLVED lands on IN_PROGRESS, CLOSED is terminal — so the machine is
 * the minimal linear chain consistent with those rules:
 *   OPEN → IN_PROGRESS → RESOLVED → CLOSED (terminal)
 *   RESOLVED → IN_PROGRESS   (automatic, on a new MEMBER message)
 * Every other transition does not exist (§3 preamble).
 */
export const TICKET_TRANSITIONS: Readonly<
  Record<TicketState, readonly TicketState[]>
> = {
  OPEN: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

/** §3.29 ANNOUNCEMENT_AUDIENCE. audience_ref MUST be null for ALL. */
export const ANNOUNCEMENT_AUDIENCES = [
  'ALL',
  'BY_PLAN',
  'SPECIFIC_SHOPS',
] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

/** §3.31 announcement.type — only WARNING sends email (A2-09, §9.19). */
export const ANNOUNCEMENT_TYPES = ['INFO', 'WARNING', 'UPDATE'] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

/** §3.31 ticket_message.author_kind. */
export type TicketAuthorKind = 'MEMBER' | 'ADMIN';

/* §5.1 size limits (A1-12). */
export const TICKET_ATTACHMENT_MAX_FILES = 5;
export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
/** ticket_message.body limit — RW-13, noted on the column in migration 0017. */
export const TICKET_MESSAGE_MAX_CHARS = 10_000;

/**
 * §9.18 canned replies. Briefed as "a simple per-platform jsonb constant
 * store — keep in code constants": the store is this constant. Keys are
 * stable identifiers the admin UI renders into a picker.
 */
export const CANNED_REPLIES: Readonly<
  Record<string, { title: string; body: string }>
> = {
  'courier-escalated': {
    title: 'Escalated to the courier',
    body: 'We have escalated this with the courier and will update you as soon as they respond.',
  },
  'need-more-info': {
    title: 'Requesting more information',
    body: 'Thanks for reporting this. Could you share the AWB or order number and a screenshot of what you see, so we can investigate?',
  },
  'known-issue': {
    title: 'Known issue, fix in progress',
    body: 'This is a known issue on our side and a fix is being rolled out. We will confirm here once it is live.',
  },
  resolved: {
    title: 'Marked resolved',
    body: 'We believe this is resolved. Reply here if anything is still wrong and the ticket will reopen.',
  },
};

export interface TicketRow {
  ticket_id: string;
  shop_id: string;
  number: string; // §13.5: TKT-{seq} per Shop
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  state: TicketState;
  assigned_admin_id: string | null;
  linked_order_id: string | null;
  linked_awb: string | null;
  created_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  version: number;
}

export interface TicketMessageRow {
  message_id: string;
  ticket_id: string;
  author_kind: TicketAuthorKind;
  author_id: string;
  body: string;
  attachments: unknown[];
  created_at: string;
}

export interface AnnouncementRow {
  announcement_id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  audience_kind: AnnouncementAudience;
  audience_ref: unknown;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface FeedbackRow {
  feedback_id: string;
  shop_id: string;
  member_id: string;
  rating: number;
  comment: string | null;
  screenshot_object_key: string | null;
  created_at: string;
}

/**
 * §9.18 response-time metrics (RW-07): first response =
 * first_response_at − created_at; resolution = resolved_at − created_at;
 * both in calendar hours. Null when the milestone has not happened.
 */
export interface TicketMetrics {
  firstResponseHours: number | null;
  resolutionHours: number | null;
}

/** RW-07: whole hours are not required — fractional calendar hours. */
export function calendarHoursBetween(
  from: string | Date,
  to: string | Date,
): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
}

export function ticketMetrics(row: TicketRow): TicketMetrics {
  return {
    firstResponseHours: row.first_response_at
      ? calendarHoursBetween(row.created_at, row.first_response_at)
      : null,
    resolutionHours: row.resolved_at
      ? calendarHoursBetween(row.created_at, row.resolved_at)
      : null,
  };
}
