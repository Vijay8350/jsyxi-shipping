import { Injectable } from '@nestjs/common';

/**
 * ADD-28 seam to the booking module. On COD-confirmation expiry with the
 * default policy (book anyway), the sweep calls bookAnyway so the order
 * proceeds through the normal booking path as if the confirmation window
 * had never applied.
 *
 * REBINDING (parent): bind COD_CONFIRMATION_BOOKER to an adapter over
 * BookingService (src/modules/booking/booking.service.ts) that queues the
 * order's ready shipment(s) for booking. The no-op default keeps the sweep
 * safe before that binding exists: the confirmation is marked EXPIRED_BOOKED
 * and the order simply follows its normal (manual or auto-ship) path.
 */
export const COD_CONFIRMATION_BOOKER = Symbol('COD_CONFIRMATION_BOOKER');

export interface CodConfirmationBooker {
  bookAnyway(shopId: string, orderId: string): Promise<void>;
}

@Injectable()
export class NoopCodConfirmationBooker implements CodConfirmationBooker {
  async bookAnyway(): Promise<void> {
    // No-op default — see the rebinding note above.
  }
}
