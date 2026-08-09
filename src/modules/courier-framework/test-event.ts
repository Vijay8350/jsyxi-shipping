import { CourierAdapter } from './adapter.types';

/**
 * ADD-18 "send test event": an adapter that can fabricate a realistic raw
 * webhook event for its courier, used to prove an account's inbound webhook
 * URL is live before the first real shipment (§8.5). The deterministic fake
 * adapter implements this; real adapters build one from a recorded sandbox
 * fixture.
 */
export interface TestWebhookEvent {
  /** The raw provider-shape payload — posted verbatim to the hooks path. */
  payload: Record<string, unknown>;
}

export interface TestEventCapableAdapter extends CourierAdapter {
  buildTestWebhookEvent(): TestWebhookEvent;
}

export function isTestEventCapable(adapter: CourierAdapter): adapter is TestEventCapableAdapter {
  return (
    typeof (adapter as Partial<TestEventCapableAdapter>).buildTestWebhookEvent === 'function'
  );
}
