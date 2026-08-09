import { ReportCode, ReportGenerator } from '../reports.types';
import { generateCodPending } from './cod-pending';
import { generateCodUnassigned } from './cod-unassigned';
import { generateCourierPerf } from './courier-perf';
import { generateInvoicePending } from './invoice-pending';
import { generateManualAssignment } from './manual-assignment';
import { generateNdr } from './ndr';
import { generateOrders } from './orders';
import { generatePaymentMode } from './payment-mode';
import { generatePincodePerf } from './pincode-perf';
import { generateProfitability } from './profitability';
import { generateReconDisputes } from './recon-disputes';
import { generateRto } from './rto';
import { generateShipments } from './shipments';
import { generateSlaDelay } from './sla-delay';

/**
 * The §11 catalogue as runnable generators — one file per report code so the
 * column check against §11 stays trivial, and so the recon-backed pair
 * (RECON_DISPUTES, COD_PENDING) isolate the SQL that starts running when the
 * weeks 14–15 recon migration lands.
 */
export const REPORT_GENERATORS: Record<ReportCode, ReportGenerator> = {
  ORDERS: generateOrders,
  SHIPMENTS: generateShipments,
  COURIER_PERF: generateCourierPerf,
  PINCODE_PERF: generatePincodePerf,
  PAYMENT_MODE: generatePaymentMode,
  NDR: generateNdr,
  RTO: generateRto,
  SLA_DELAY: generateSlaDelay,
  RECON_DISPUTES: generateReconDisputes,
  COD_PENDING: generateCodPending,
  MANUAL_ASSIGNMENT: generateManualAssignment,
  PROFITABILITY: generateProfitability,
  INVOICE_PENDING: generateInvoicePending,
  COD_UNASSIGNED: generateCodUnassigned,
};
