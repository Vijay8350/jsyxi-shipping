import { describe, expect, it } from 'vitest';
import { MemberRole } from '../../src/auth/session.types';
import {
  ALL_MERCHANT_ROLES,
  canRead,
  hasPermission,
  PERMISSIONS,
  PermissionKey,
} from '../../src/modules/team/rbac/permissions';

/**
 * The §10.2 merchant permission matrix, transcribed a second time from the
 * spec — independently of src/modules/team/rbac/permissions.ts — so this
 * test cross-checks the catalog row by row, role by role.
 * full = `✓` roles, read = `R` roles; a role in neither is denied (`—`).
 */
const OWNER: MemberRole = 'OWNER';
const OP: MemberRole = 'OPERATOR';
const FIN: MemberRole = 'FINANCE';
const VIEW: MemberRole = 'VIEWER';

const EXPECTED: Record<string, { full: MemberRole[]; read: MemberRole[] }> = {
  'orders.view': { full: [OWNER, OP, FIN], read: [VIEW] },
  'shipment.book': { full: [OWNER, OP], read: [] },
  'shipment.cancel': { full: [OWNER, OP], read: [] },
  'collectible.move': { full: [OWNER, OP], read: [] },
  'pickup.schedule': { full: [OWNER, OP], read: [] },
  'ndr.act': { full: [OWNER, OP], read: [] },
  'documents.generate': { full: [OWNER, OP, FIN], read: [] },
  'gst_invoice.issue': { full: [OWNER, FIN], read: [] },
  'rules.edit': { full: [OWNER, OP], read: [VIEW] },
  'rules.default_chain.edit': { full: [OWNER, OP], read: [VIEW] },
  'rules.simulate': { full: [OWNER, OP, FIN], read: [VIEW] },
  'rate_cards.edit': { full: [OWNER, FIN], read: [VIEW] },
  'recon.edit': { full: [OWNER, FIN], read: [VIEW] },
  'recon.residual.accept': { full: [OWNER, FIN], read: [] },
  'reports.run': { full: [OWNER, OP, FIN, VIEW], read: [] },
  'courier_accounts.manage': { full: [OWNER], read: [] },
  'packages.manage': { full: [OWNER, OP], read: [VIEW] },
  'pickup_address.edit': { full: [OWNER], read: [] },
  'shopify_locations.mark': { full: [OWNER], read: [] },
  'settings.store.edit': { full: [OWNER], read: [] },
  'settings.templates.edit': { full: [OWNER], read: [] },
  'labels.print_size.choose': { full: [OWNER, OP], read: [] },
  'settings.invoice_series.edit': { full: [OWNER, FIN], read: [] },
  'settings.order_sync.edit': { full: [OWNER], read: [] },
  'settings.auto_ship.edit': { full: [OWNER], read: [] },
  'settings.recon.edit': { full: [OWNER, FIN], read: [] },
  'settings.ndr_notifications.edit': { full: [OWNER, OP], read: [] },
  'team.manage': { full: [OWNER], read: [] },
  'billing.manage': { full: [OWNER], read: [] },
  'settings.track_page.edit': { full: [OWNER], read: [] },
  'test_shipments.bulk_delete': { full: [OWNER], read: [] },
  'tickets.use': { full: [OWNER, OP, FIN, VIEW], read: [] },
  // §10.2 deny rows: denied to every merchant role, Owner included.
  'credentials.read': { full: [], read: [] },
  'dlq.replay': { full: [], read: [] },
};

const sort = (roles: readonly string[]) => [...roles].sort();

describe('§10.2 permission matrix', () => {
  it('catalog covers exactly the §10.2 rows — no more, no fewer', () => {
    expect(sort(Object.keys(PERMISSIONS) as string[])).toEqual(
      sort(Object.keys(EXPECTED)),
    );
    // §10.2 has 34 rows.
    expect(Object.keys(PERMISSIONS)).toHaveLength(34);
  });

  it.each(Object.entries(EXPECTED))(
    '%s — every role allowed/denied exactly as §10.2',
    (key, expected) => {
      const rule = PERMISSIONS[key as PermissionKey];
      expect(rule, `catalog is missing '${key}'`).toBeDefined();
      expect(sort(rule.allow)).toEqual(sort(expected.full));
      expect(sort(rule.readOnly)).toEqual(sort(expected.read));

      for (const role of ALL_MERCHANT_ROLES) {
        const shouldAllow = expected.full.includes(role);
        const shouldRead = shouldAllow || expected.read.includes(role);
        expect(hasPermission(role, key as PermissionKey)).toBe(shouldAllow);
        expect(canRead(role, key as PermissionKey)).toBe(shouldRead);
      }
    },
  );

  it('deny rows are explicit: deniedToAll, empty allow, denied to all roles', () => {
    for (const key of ['credentials.read', 'dlq.replay'] as const) {
      expect(PERMISSIONS[key].deniedToAll).toBe(true);
      expect(PERMISSIONS[key].allow).toHaveLength(0);
      for (const role of ALL_MERCHANT_ROLES) {
        // Owner denied credential read-back and DLQ replay (RV-10, INV-18).
        expect(hasPermission(role, key)).toBe(false);
        expect(canRead(role, key)).toBe(false);
      }
    }
  });

  it('§10.1 shorthands: Operator+ never includes Finance; Finance+ never includes Operator', () => {
    // Spot-check rows the spec defines via the shorthands.
    expect(hasPermission(FIN, 'shipment.book')).toBe(false); // Operator+ row
    expect(hasPermission(OP, 'rate_cards.edit')).toBe(false); // Finance+ row
    expect(hasPermission(FIN, 'recon.residual.accept')).toBe(true);
    expect(hasPermission(OP, 'settings.recon.edit')).toBe(false);
  });

  it('every entry carries a §10.2 provenance source', () => {
    for (const rule of Object.values(PERMISSIONS)) {
      expect(rule.source.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });
});
