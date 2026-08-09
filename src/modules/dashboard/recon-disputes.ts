import { Injectable } from '@nestjs/common';

/**
 * Seam for the §9.10 "recon disputes open" action card.
 *
 * The recon tables (`recon_freight_row`, `recon_cod_row`,
 * `recon_freight_batch`, …) land with the reconciliation block in weeks
 * 14–15 (§14); they do not exist in migrations yet. The rollup therefore
 * reads the dispute count through this provider instead of querying the
 * tables directly.
 *
 * BINDING NOTE (weeks 14–15): the recon module MUST rebind
 * RECON_DISPUTES_PROVIDER with an implementation running the §3.14 counting
 * rule against the real tables:
 *
 *   count of recon rows whose workflow_state IN
 *     ('OPEN', 'DISPUTE_PREPARED', 'SUBMITTED')            — §3.14
 *   plus one item per recon_freight_batch whose
 *     control_total_state = 'MISMATCH'                     — §3.28, RW-18
 *
 * shop-scoped (INV-1). Recon rows are never created for test shipments
 * (INV-19, §5.3), so the count needs no test-side variant.
 */
export const RECON_DISPUTES_PROVIDER = Symbol('RECON_DISPUTES_PROVIDER');

export interface ReconDisputesProvider {
  countOpenDisputes(shopId: string): Promise<number>;
}

/** Default until the recon block rebinds the token: zero open disputes. */
@Injectable()
export class ZeroReconDisputesProvider implements ReconDisputesProvider {
  async countOpenDisputes(): Promise<number> {
    return 0;
  }
}
