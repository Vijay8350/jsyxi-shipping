import { ReportCode } from './reports.types';

/**
 * The §11 report catalogue, transcribed as data — the single machine
 * authority for codes, names, row grain, attribution dates (§5.2) and the
 * notable-column lists. Generators MUST emit exactly `columns` (same order);
 * the test suite checks every entry against §11.
 *
 * countingUnit is labelled in every export header (§11/§5.2, A2-06).
 */
export interface ReportDefinition {
  code: ReportCode;
  /** §11 "Report" name. */
  name: string;
  /** §11 "Rows" grain. */
  rowGrain: string;
  /** §5.2 period-attribution date, named per report. */
  attribution: string;
  /** A2-06: what the figures count ('shipments' default; 'orders' labelled). */
  countingUnit: 'shipments' | 'orders' | 'ndr_cases' | 'recon_rows';
  /** §11 "Notable columns", exact header labels used in the CSV. */
  columns: string[];
}

export const REPORT_CATALOGUE: Record<ReportCode, ReportDefinition> = {
  ORDERS: {
    code: 'ORDERS',
    name: 'Order export',
    rowGrain: 'Orders',
    attribution: 'Shopify created-at',
    countingUnit: 'orders',
    columns: [
      'order_number',
      'created_at',
      'order_amount',
      'payment_mode',
      'derived_status',
      'shipment_count',
      'cod_outstanding',
      'cod_assignment_state',
    ],
  },
  SHIPMENTS: {
    code: 'SHIPMENTS',
    name: 'Shipment / AWB',
    rowGrain: 'Shipments',
    attribution: 'booked-at',
    countingUnit: 'shipments',
    columns: [
      'awb',
      'service',
      'booked_at',
      'dead_weight_kg',
      'billable_weight_kg',
      'expected_cost',
      'expected_cost_basis',
      'collectible',
      'movement_state',
      'delivered_at',
      'tat_hours',
    ],
  },
  COURIER_PERF: {
    code: 'COURIER_PERF',
    name: 'Courier performance',
    rowGrain: 'Service',
    attribution: 'booked-at',
    countingUnit: 'shipments',
    columns: [
      'service',
      'volume',
      'open_count',
      'delivery_rate',
      'ndr_rate',
      'rto_rate',
      'avg_tat_hours',
    ],
  },
  PINCODE_PERF: {
    code: 'PINCODE_PERF',
    name: 'Pincode performance',
    rowGrain: 'Destination pincode',
    attribution: 'booked-at',
    countingUnit: 'shipments',
    columns: [
      'destination_pincode',
      'zone',
      'volume',
      'open_count',
      'delivery_rate',
      'ndr_rate',
      'rto_rate',
      'avg_tat_hours',
    ],
  },
  PAYMENT_MODE: {
    code: 'PAYMENT_MODE',
    name: 'Payment-mode analysis',
    rowGrain: 'Payment mode × period',
    attribution: 'booked-at',
    countingUnit: 'shipments',
    columns: ['period', 'payment_mode', 'volume', 'value', 'delivery_rate', 'rto_rate'],
  },
  NDR: {
    code: 'NDR',
    name: 'NDR',
    rowGrain: 'NDR cases',
    attribution: 'first-NDR-at',
    countingUnit: 'ndr_cases',
    columns: ['awb', 'reason', 'case_state', 'attempts', 'action_taken', 'age_days', 'outcome'],
  },
  RTO: {
    code: 'RTO',
    name: 'RTO',
    rowGrain: 'Shipments in RTO',
    attribution: 'RTO-initiated-at',
    countingUnit: 'shipments',
    columns: ['awb', 'rto_initiated_at', 'reason', 'rto_charge', 'rto_delivered_at'],
  },
  SLA_DELAY: {
    code: 'SLA_DELAY',
    name: 'SLA / delay',
    rowGrain: 'Shipments',
    attribution: 'booked-at',
    countingUnit: 'shipments',
    columns: ['awb', 'edd', 'actual', 'delay_hours', 'delayed_flag'],
  },
  RECON_DISPUTES: {
    code: 'RECON_DISPUTES',
    name: 'Freight recon disputes',
    rowGrain: 'recon_freight_row',
    attribution: 'invoice date (upload date separately filterable)',
    countingUnit: 'recon_rows',
    columns: [
      'awb',
      'charge_type',
      'invoiced_amount',
      'expected_amount',
      'audited_amount',
      'flag_awb_not_found',
      'flag_weight_mismatch',
      'flag_amount_mismatch',
      'flag_review',
      'workflow_state',
      'batch_residual',
      'control_total_state',
    ],
  },
  COD_PENDING: {
    code: 'COD_PENDING',
    name: 'COD pending remittance',
    rowGrain: 'recon_cod_expected',
    attribution: 'remittance date (upload date separately filterable)',
    countingUnit: 'recon_rows',
    columns: ['awb', 'expected_amount', 'allocated_amount', 'balance', 'due_date', 'aging_days', 'state'],
  },
  MANUAL_ASSIGNMENT: {
    code: 'MANUAL_ASSIGNMENT',
    name: 'Shipments needing manual assignment',
    rowGrain: 'Shipments with BOOKING_STATE = NEEDS_MANUAL_ASSIGNMENT',
    attribution: 'booked-at',
    countingUnit: 'shipments',
    columns: ['order_number', 'awb', 'manual_assignment_reason', 'service_failure_reasons', 'age_days'],
  },
  PROFITABILITY: {
    code: 'PROFITABILITY',
    name: 'Shipment profitability',
    rowGrain: 'Shipments',
    attribution: 'booked-at',
    countingUnit: 'shipments',
    columns: [
      'awb',
      'order_amount',
      'expected_freight',
      'invoiced_freight',
      'variance',
      'margin',
    ],
  },
  INVOICE_PENDING: {
    code: 'INVOICE_PENDING',
    name: 'Invoices awaiting issue',
    rowGrain: 'gst_invoice in ISSUE_PENDING',
    attribution: 'invoice created-at',
    countingUnit: 'orders',
    columns: ['order_number', 'invoice_state', 'missing_fields', 'age_days'],
  },
  COD_UNASSIGNED: {
    code: 'COD_UNASSIGNED',
    name: 'COD orders with no collectible-bearing shipment',
    rowGrain: 'Orders with cod_assignment_state = UNASSIGNED',
    attribution: 'Shopify created-at',
    countingUnit: 'orders',
    columns: ['order_number', 'cod_outstanding', 'shipments_booked', 'flagged_at', 'age_days'],
  },
};

export function isReportCode(value: string): value is ReportCode {
  return (REPORT_CODES_SET as Set<string>).has(value);
}

const REPORT_CODES_SET = new Set<string>(Object.keys(REPORT_CATALOGUE));
