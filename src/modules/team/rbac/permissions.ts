import { MemberRole } from '../../../auth/session.types';

/**
 * §10.2 merchant permission matrix, transcribed as data — the sole machine
 * authority on who may do what. One entry per §10.2 row, verbatim:
 *
 *   allow     = roles with `✓` in the matrix
 *   readOnly  = roles with `R` (read-only grant on the same object)
 *   deniedToAll = rows where §10.2 denies every merchant role (`—` × 4);
 *               these are encoded explicitly so the denial is deliberate,
 *               never the accidental absence of a rule.
 *
 * Shorthands (§10.1, defined there and nowhere else):
 *   "Operator+" = OPERATOR or OWNER — never FINANCE.
 *   "Finance+"  = FINANCE or OWNER.
 * "No access" is the ABSENCE of a shop_member row (§10.1), so it appears
 * in no role set anywhere below — deny-by-default is structural (§9.1.2).
 */

export const ALL_MERCHANT_ROLES: readonly MemberRole[] = [
  'OWNER',
  'OPERATOR',
  'FINANCE',
  'VIEWER',
];

// §10.1 shorthands.
const OWNER: MemberRole = 'OWNER';
const OPERATOR: MemberRole = 'OPERATOR';
const FINANCE: MemberRole = 'FINANCE';
const VIEWER: MemberRole = 'VIEWER';
const OPERATOR_PLUS: readonly MemberRole[] = [OWNER, OPERATOR];
const FINANCE_PLUS: readonly MemberRole[] = [OWNER, FINANCE];

export interface PermissionRule {
  /** §10.2 `✓` roles — full permission. */
  readonly allow: readonly MemberRole[];
  /** §10.2 `R` roles — read-only on the same object. */
  readonly readOnly: readonly MemberRole[];
  /** The §10.2 row text (action / object). */
  readonly description: string;
  /** The §10.2 source column, for provenance. */
  readonly source: string;
  /** True where §10.2 denies the action to every merchant role. */
  readonly deniedToAll?: true;
}

const rule = (
  allow: readonly MemberRole[],
  readOnly: readonly MemberRole[],
  description: string,
  source: string,
  deniedToAll?: true,
): PermissionRule => ({ allow, readOnly, description, source, deniedToAll });

export const PERMISSIONS = {
  // §10.2 — "View orders, shipments, tracking" ✓ ✓ ✓ R
  'orders.view': rule(
    [OWNER, OPERATOR, FINANCE],
    [VIEWER],
    'View orders, shipments, tracking',
    'A1-07, RV-10',
  ),
  // §10.2 — "Book / bulk-book a shipment" ✓ ✓ — —
  'shipment.book': rule(
    OPERATOR_PLUS,
    [],
    'Book / bulk-book a shipment',
    'RV-10',
  ),
  // §10.2 — "Cancel a shipment before pickup" ✓ ✓ — —
  'shipment.cancel': rule(
    OPERATOR_PLUS,
    [],
    'Cancel a shipment before pickup',
    'RV-10',
  ),
  // §10.2 — "Move the Collectible between unbooked shipments" ✓ ✓ — —
  'collectible.move': rule(
    OPERATOR_PLUS,
    [],
    'Move the Collectible between unbooked shipments',
    'RV-10, §4.7',
  ),
  // §10.2 — "Schedule pickup, generate manifest" ✓ ✓ — —
  'pickup.schedule': rule(
    OPERATOR_PLUS,
    [],
    'Schedule pickup, generate manifest',
    'RV-10',
  ),
  // §10.2 — "NDR actions (reattempt, update address, initiate RTO)" ✓ ✓ — —
  'ndr.act': rule(
    OPERATOR_PLUS,
    [],
    'NDR actions (reattempt, update address, initiate RTO)',
    'RV-10',
  ),
  // §10.2 — "Generate / re-download labels, packing slips" ✓ ✓ ✓ —
  'documents.generate': rule(
    [OWNER, OPERATOR, FINANCE],
    [],
    'Generate / re-download labels, packing slips',
    'RV-10',
  ),
  // §10.2 — "Issue or void a GST invoice" ✓ — ✓ — (a tax document is a finance act)
  'gst_invoice.issue': rule(
    FINANCE_PLUS,
    [],
    'Issue or void a GST invoice',
    'RV-10',
  ),
  // §10.2 — "Create / edit rules, saved zones" ✓ ✓ — R (routing is an operations act)
  'rules.edit': rule(
    OPERATOR_PLUS,
    [VIEWER],
    'Create / edit rules, saved zones',
    'RV-10',
  ),
  // §10.2 — "Set the default chain (S-22)" ✓ ✓ — R
  'rules.default_chain.edit': rule(
    OPERATOR_PLUS,
    [VIEWER],
    'Set the default chain (S-22)',
    'RV-10',
  ),
  // §10.2 — "Run the rule simulator" ✓ ✓ ✓ R
  'rules.simulate': rule(
    [OWNER, OPERATOR, FINANCE],
    [VIEWER],
    'Run the rule simulator',
    'RW-25',
  ),
  // §10.2 — "Create / edit rate cards and zone maps" ✓ — ✓ R
  'rate_cards.edit': rule(
    FINANCE_PLUS,
    [VIEWER],
    'Create / edit rate cards and zone maps',
    'RV-10',
  ),
  // §10.2 — "Upload reconciliation files; accept, dispute, resolve rows" ✓ — ✓ R
  'recon.edit': rule(
    FINANCE_PLUS,
    [VIEWER],
    'Upload reconciliation files; accept, dispute, resolve rows',
    'RV-10',
  ),
  // §10.2 — "Accept a control-total residual with a remark (§3.28)" ✓ — ✓ —
  'recon.residual.accept': rule(
    FINANCE_PLUS,
    [],
    'Accept a control-total residual with a remark (§3.28)',
    'RV-10',
  ),
  // §10.2 — "Run and schedule reports; download exports" ✓ ✓ ✓ ✓
  'reports.run': rule(
    ALL_MERCHANT_ROLES,
    [],
    'Run and schedule reports; download exports',
    'RV-10',
  ),
  // §10.2 — "Manage courier accounts and credentials" ✓ — — —
  'courier_accounts.manage': rule(
    [OWNER],
    [],
    'Manage courier accounts and credentials',
    'RV-10',
  ),
  // §10.2 — "Manage package profiles, selection rules and SKU overrides" ✓ ✓ — R
  'packages.manage': rule(
    OPERATOR_PLUS,
    [VIEWER],
    'Manage package profiles, selection rules and SKU overrides',
    'RV-10',
  ),
  // §10.2 — "Edit the pickup address" ✓ — — —
  'pickup_address.edit': rule(
    [OWNER],
    [],
    'Edit the pickup address',
    'RV-10',
  ),
  // §10.2 — "Mark a Shopify location as not shipped by Jsyxi" ✓ — — —
  'shopify_locations.mark': rule(
    [OWNER],
    [],
    'Mark a Shopify location as not shipped by Jsyxi',
    'RV-10',
  ),
  // §10.2 — "Change store general settings (S-1–S-7)" ✓ — — —
  'settings.store.edit': rule(
    [OWNER],
    [],
    'Change store general settings (S-1–S-7)',
    'RV-10',
  ),
  // §10.2 — "Change label & invoice template customization (S-24)" ✓ — — —
  'settings.templates.edit': rule(
    [OWNER],
    [],
    'Change label & invoice template customization (S-24)',
    'RV-10',
  ),
  // §10.2 — "Choose label size at print time (S-23)" ✓ ✓ — —
  'labels.print_size.choose': rule(
    OPERATOR_PLUS,
    [],
    'Choose label size at print time (S-23)',
    'RV-10',
  ),
  // §10.2 — "Change the invoice series code (S-25)" ✓ — ✓ —
  'settings.invoice_series.edit': rule(
    FINANCE_PLUS,
    [],
    'Change the invoice series code (S-25)',
    'RV-10',
  ),
  // §10.2 — "Change order-sync preferences (S-8, S-9, S-14)" ✓ — — —
  'settings.order_sync.edit': rule(
    [OWNER],
    [],
    'Change order-sync preferences (S-8, S-9, S-14)',
    'RV-10',
  ),
  // §10.2 — "Enable / disable auto-ship and its parameters (S-10–S-13)" ✓ — — —
  'settings.auto_ship.edit': rule(
    [OWNER],
    [],
    'Enable / disable auto-ship and its parameters (S-10–S-13)',
    'RV-10',
  ),
  // §10.2 — "Change reconciliation settings (S-27–S-30)" ✓ — ✓ —
  'settings.recon.edit': rule(
    FINANCE_PLUS,
    [],
    'Change reconciliation settings, Shop-level or per courier account (S-27–S-30)',
    'RV-10',
  ),
  // §10.2 — "Change NDR and notification settings (S-41–S-47)" ✓ ✓ — —
  'settings.ndr_notifications.edit': rule(
    OPERATOR_PLUS,
    [],
    'Change NDR and notification settings (S-41–S-47)',
    'RV-10',
  ),
  // §10.2 — "Team & Roles: grant, change, revoke; resolve an access request" ✓ — — —
  'team.manage': rule(
    [OWNER],
    [],
    'Team & Roles: grant, change, revoke; resolve an access request',
    'A2-03, RV-10',
  ),
  // §10.2 — "Billing: upgrade, downgrade, approve overage" ✓ — — —
  'billing.manage': rule(
    [OWNER],
    [],
    'Billing: upgrade, downgrade, approve overage',
    'RV-10',
  ),
  // §10.2 — "Track-order page configuration (S-31–S-38, S-49)" ✓ — — —
  'settings.track_page.edit': rule(
    [OWNER],
    [],
    'Track-order page configuration (S-31–S-38, S-49)',
    'RV-10',
  ),
  // §10.2 — "Bulk-delete test shipments (§9.5.7)" ✓ — — —
  'test_shipments.bulk_delete': rule(
    [OWNER],
    [],
    'Bulk-delete test shipments (§9.5.7)',
    'A4-04, RV-10',
  ),
  // §10.2 — "Raise and reply to tickets; submit feedback" ✓ ✓ ✓ ✓
  'tickets.use': rule(
    ALL_MERCHANT_ROLES,
    [],
    'Raise and reply to tickets; submit feedback',
    'RW-25',
  ),
  // §10.2 — "Read back a stored courier credential" — — — —
  // Denied to EVERY role including Owner (RV-10, INV-18). Credentials are
  // write-only with a masked display and a "replace" action (§10.2 note).
  'credentials.read': rule(
    [],
    [],
    'Read back a stored courier credential',
    'RV-10, INV-18',
    true,
  ),
  // §10.2 — "Replay a DLQ item" — — — — (a platform-staff action, §10.3)
  'dlq.replay': rule(
    [],
    [],
    'Replay a DLQ item',
    'RV-10',
    true,
  ),
} as const satisfies Record<string, PermissionRule>;

export type PermissionKey = keyof typeof PERMISSIONS;

/** §10.2 `✓` check — full permission to perform the action. */
export function hasPermission(role: MemberRole, key: PermissionKey): boolean {
  return (PERMISSIONS[key].allow as readonly MemberRole[]).includes(role);
}

/** §10.2 `✓` or `R` — may at least read the object. */
export function canRead(role: MemberRole, key: PermissionKey): boolean {
  const ruleDef = PERMISSIONS[key];
  return (
    (ruleDef.allow as readonly MemberRole[]).includes(role) ||
    (ruleDef.readOnly as readonly MemberRole[]).includes(role)
  );
}
