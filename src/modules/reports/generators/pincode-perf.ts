import { REPORT_CATALOGUE } from '../report-catalogue';
import { ReportData, ReportGenerator } from '../reports.types';
import { ratio, runPerfQuery } from './courier-perf';

/**
 * §11 PINCODE_PERF — Pincode performance. Grain: destination pincode (from
 * the frozen snapshot's formula inputs, §2.9); same F-16 metric set as
 * COURIER_PERF plus the booking's resolved Zone (§4.3, frozen in the
 * snapshot — never the current postal master, A1-05).
 */
export const generatePincodePerf: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const rows = await runPerfQuery(
    q,
    ctx,
    `s.snapshot -> 'formulaInputs' ->> 'destinationPincode'`,
    true,
  );
  return {
    columns: REPORT_CATALOGUE.PINCODE_PERF.columns,
    rows: rows.map((r) => [
      r.key,
      r.zone,
      r.volume,
      r.open_count,
      ratio(r.delivered, String(Number(r.delivered) + Number(r.rto_delivered))),
      ratio(r.with_ndr, r.picked_up),
      ratio(r.rto_delivered, r.terminal),
      r.avg_tat_hours,
    ]),
  };
};
