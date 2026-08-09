import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { MemberRole } from '../../auth/session.types';
import { MessageDispatcherService } from './message-dispatcher.service';
import { NotificationSettingsService } from './notification-settings.service';
import { InAppService } from './in-app.service';
import { ThrottleService } from './throttle.service';
import { DigestService } from './digest.service';
import {
  NOTIFICATION_EVENTS,
  NotificationEvent,
  NotifyContext,
  NotifyResult,
  ONLINE_WINDOW_MINUTES,
} from './notifications.types';

/**
 * The §9.21 notification matrix (A2-09). One entry point —
 * notify(shopId, event, context) — implements the recipient / channel /
 * throttle table exactly:
 *
 *   courier.disconnected      Owner              email + in-app      S-46
 *   booking.batch_complete    the actor          in-app; email if offline, immediate
 *   ndr.received              S-41 recipients    email digest        S-42
 *   pickup.not_scheduled      Operator           email digest        daily
 *   shipment.delayed          Operator           email digest        daily (S-47)
 *   billing.allowance_80/100  Owner              email + in-app      immediate
 *   billing.trial_ending      Owner              email + in-app      immediate
 *   recon.batch_disputed      Finance            email + in-app      immediate
 *   report.ready              the requester      email, expiring link, on completion
 *   ticket.reply              participants       email + in-app      immediate
 *   announcement              all Members        in-app; email only if WARNING
 *   cod.unassigned            Owner + Finance    in-app card + daily email digest
 *   invoice.pending           Owner + Finance    in-app card + daily email digest
 *
 * Where no Member holds the named role the recipient falls back to the Owner
 * (§9.21 pass-3 (c)). S-45 toggles gate every event (default ON). INV-21:
 * this method NEVER throws into a caller's business path — every failure is
 * caught, logged (class only, §5.7 control 4) and reflected in the result.
 */

interface MemberRow {
  member_id: string;
  role: MemberRole;
  email: string | null;
  last_active_at: string | null;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly dispatcher: MessageDispatcherService,
    private readonly settings: NotificationSettingsService,
    private readonly inApp: InAppService,
    private readonly throttle: ThrottleService,
    private readonly digests: DigestService,
  ) {}

  private async members(shopId: string): Promise<MemberRow[]> {
    const result = await this.pool.query<MemberRow>(
      `SELECT member_id, role, email, last_active_at
         FROM shop_member
        WHERE shop_id = $1 AND revoked_at IS NULL`,
      [shopId],
    );
    return result.rows;
  }

  /** §9.21: role recipient with Owner fallback (pass-3 (c)). */
  private byRoleWithFallback(
    all: MemberRow[],
    roles: MemberRole[],
  ): MemberRow[] {
    const matched = all.filter((m) => roles.includes(m.role));
    if (matched.length > 0) return matched;
    return all.filter((m) => m.role === 'OWNER');
  }

  /** "Email if the actor is offline": no activity in ONLINE_WINDOW_MINUTES. */
  private isOffline(member: MemberRow, now: Date): boolean {
    if (!member.last_active_at) return true;
    return (
      now.getTime() - new Date(member.last_active_at).getTime() >
      ONLINE_WINDOW_MINUTES * 60_000
    );
  }

  private async emailMember(
    shopId: string,
    member: MemberRow,
    event: string,
    context: NotifyContext,
  ): Promise<boolean> {
    if (!member.email) return false; // SHOPIFY_STAFF rows carry no email (OVR-1)
    const result = await this.dispatcher.dispatch({
      shopId,
      channel: 'EMAIL',
      event,
      to: member.email,
      subject: context.subject,
      body: context.link ? `${context.body}\n\n${context.link}` : context.body,
      shipmentId: context.shipmentId,
      ndrCaseId: context.ndrCaseId,
    });
    return result.state !== 'FAILED';
  }

  /**
   * Deliver to one member over the given channels. S-46 throttle applies per
   * recipient when `useThrottle` — the first send in a window appends the
   * lapsed window's suppressed count ("with a count").
   */
  private async deliver(
    shopId: string,
    member: MemberRow,
    event: string,
    context: NotifyContext,
    opts: { email: boolean; inApp: boolean; useThrottle: boolean },
    result: NotifyResult,
  ): Promise<void> {
    let ctx = context;
    if (opts.useThrottle) {
      const decision = await this.throttle.check(shopId, event, member.member_id);
      if (!decision.allowed) {
        result.suppressed += 1;
        return;
      }
      if (decision.previouslySuppressed > 0) {
        ctx = {
          ...context,
          body: `${context.body}\n\n(${decision.previouslySuppressed} further occurrence(s) were throttled in the previous hour — S-46.)`,
        };
      }
    }
    if (opts.inApp) {
      await this.inApp.writeInApp(shopId, member.member_id, {
        subject: ctx.subject,
        body: ctx.body,
        link: ctx.link,
        shipmentId: ctx.shipmentId,
        ndrCaseId: ctx.ndrCaseId,
      });
      result.delivered += 1;
    }
    if (opts.email && (await this.emailMember(shopId, member, event, ctx))) {
      result.delivered += 1;
    }
  }

  async notify(
    shopId: string,
    event: NotificationEvent,
    context: NotifyContext,
  ): Promise<NotifyResult> {
    const result: NotifyResult = {
      delivered: 0,
      suppressed: 0,
      digested: 0,
      skipped: false,
    };
    try {
      // S-45: per-event toggle, default ON.
      if (!(await this.settings.isEventEnabled(shopId, event))) {
        result.skipped = true;
        return result;
      }
      const all = await this.members(shopId);
      const now = new Date();

      switch (event) {
        case NOTIFICATION_EVENTS.COURIER_DISCONNECTED: {
          for (const m of this.byRoleWithFallback(all, ['OWNER'])) {
            await this.deliver(shopId, m, event, context, { email: true, inApp: true, useThrottle: true }, result);
          }
          break;
        }
        case NOTIFICATION_EVENTS.BOOKING_BATCH_COMPLETE: {
          const actor = all.find((m) => m.member_id === context.actorMemberId);
          if (actor) {
            await this.deliver(
              shopId, actor, event, context,
              { email: this.isOffline(actor, now), inApp: true, useThrottle: false },
              result,
            );
          }
          break;
        }
        case NOTIFICATION_EVENTS.NDR_RECEIVED: {
          // S-42 digest — recipients resolved at digest-send time from
          // ndr_settings (S-41) with the Owner fallback.
          for (const line of context.lines ?? [context.body]) {
            await this.digests.enqueue(shopId, 'ndr', line);
            result.digested += 1;
          }
          break;
        }
        case NOTIFICATION_EVENTS.PICKUP_NOT_SCHEDULED:
        case NOTIFICATION_EVENTS.SHIPMENT_DELAYED: {
          for (const line of context.lines ?? [context.body]) {
            await this.digests.enqueue(shopId, 'ops', `[${event}] ${line}`);
            result.digested += 1;
          }
          break;
        }
        case NOTIFICATION_EVENTS.ALLOWANCE_80:
        case NOTIFICATION_EVENTS.ALLOWANCE_100:
        case NOTIFICATION_EVENTS.TRIAL_ENDING: {
          for (const m of this.byRoleWithFallback(all, ['OWNER'])) {
            await this.deliver(shopId, m, event, context, { email: true, inApp: true, useThrottle: false }, result);
          }
          break;
        }
        case NOTIFICATION_EVENTS.RECON_BATCH_DISPUTED: {
          for (const m of this.byRoleWithFallback(all, ['FINANCE'])) {
            await this.deliver(shopId, m, event, context, { email: true, inApp: true, useThrottle: false }, result);
          }
          break;
        }
        case NOTIFICATION_EVENTS.REPORT_READY: {
          const requester = all.find(
            (m) => m.member_id === context.requesterMemberId,
          );
          if (requester) {
            await this.deliver(shopId, requester, event, context, { email: true, inApp: false, useThrottle: false }, result);
          }
          break;
        }
        case NOTIFICATION_EVENTS.TICKET_REPLY: {
          const participants = all.filter((m) =>
            (context.participantMemberIds ?? []).includes(m.member_id),
          );
          for (const m of participants) {
            await this.deliver(shopId, m, event, context, { email: true, inApp: true, useThrottle: false }, result);
          }
          break;
        }
        case NOTIFICATION_EVENTS.ANNOUNCEMENT: {
          const warning = context.announcementType === 'WARNING';
          for (const m of all) {
            await this.deliver(shopId, m, event, context, { email: warning, inApp: true, useThrottle: false }, result);
          }
          break;
        }
        case NOTIFICATION_EVENTS.COD_UNASSIGNED:
        case NOTIFICATION_EVENTS.INVOICE_PENDING: {
          // In-app action card immediately; the email goes out in the daily digest.
          for (const m of this.byRoleWithFallback(all, ['OWNER', 'FINANCE'])) {
            await this.deliver(shopId, m, event, context, { email: false, inApp: true, useThrottle: false }, result);
          }
          for (const line of context.lines ?? [context.body]) {
            await this.digests.enqueue(shopId, 'finance', `[${event}] ${line}`);
            result.digested += 1;
          }
          break;
        }
      }
    } catch (err) {
      // INV-21: a notification failure must never surface in a business path.
      this.logger.error(
        `notify ${event} failed: ${err instanceof Error ? err.name : 'Error'}`,
      );
    }
    return result;
  }
}
