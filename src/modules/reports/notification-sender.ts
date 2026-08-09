import { Injectable } from '@nestjs/common';
import { ReportCode } from './reports.types';

/**
 * §9.21 "Scheduled or ad-hoc report ready → the requester → email with an
 * expiring link". This module defines the narrow seam; the notifications
 * module (§9.21 + ADD-25 channel layer) binds NOTIFICATION_SENDER when it
 * lands. The default is a deliberate no-op (INV-21: no notification gates a
 * business action — a report must never fail because mail did).
 *
 * The message carries no PII beyond the recipient addresses supplied by the
 * merchant on the schedule, and the link is the only payload — exports are
 * never attachments (A1-12).
 */
export interface ReportReadyMessage {
  shopId: string;
  reportCode: ReportCode;
  reportJobId: string;
  /** Ad-hoc jobs: the requesting Member (sender resolves the address). */
  requestedBy: string | null;
  /** Scheduled jobs: the schedule's recipient list. */
  recipients: string[];
  /** App-relative signed URL (S-26 semantics); expiring. */
  downloadUrl: string;
  expiresAt: Date;
  rowCount: number;
}

export interface NotificationSender {
  sendReportReady(message: ReportReadyMessage): Promise<void>;
}

export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');

@Injectable()
export class NoopNotificationSender implements NotificationSender {
  async sendReportReady(): Promise<void> {
    // Bound by the notifications module; inert by default (INV-21).
  }
}
