import { Injectable } from '@nestjs/common';

/**
 * ADD-27 seam to the NDR suite (machine F, §3.10), which is being built in
 * parallel in src/modules/ndr/. When that module lands it will export
 * NdrActionService.submit; REBINDING: bind this token to an adapter whose
 * processBuyerResponse(responseId) loads the ndr_buyer_response row and
 * creates the corresponding ndr_action via NdrActionService.submit, then
 * sets ndr_buyer_response.ndr_action_id (migration 0014 grants UPDATE for
 * exactly that back-link).
 *
 * The INV-21 exception is explicit here (addendum ADD-27): a buyer response
 * DOES drive a business action — but from the stored, audited
 * ndr_buyer_response record, never from message delivery. A processor
 * failure therefore never loses the response; the row stays actionable.
 */
export const NDR_RESPONSE_PROCESSOR = Symbol('NDR_RESPONSE_PROCESSOR');

export interface NdrResponseProcessor {
  processBuyerResponse(responseId: string): Promise<void>;
}

@Injectable()
export class NoopNdrResponseProcessor implements NdrResponseProcessor {
  async processBuyerResponse(): Promise<void> {
    // No-op until the NDR module binds over NDR_RESPONSE_PROCESSOR. The
    // audited ndr_buyer_response row is already durable at this point.
  }
}
