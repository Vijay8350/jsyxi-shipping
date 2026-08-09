import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, SessionGuard } from '../../auth/session.guard';
import { RolesGuard } from '../team/rbac/roles.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { TestShipmentsService } from './test-shipments.service';

/**
 * §9.5.7 test-shipment housekeeping (§5.3 carve-out, §10.2). Both endpoints
 * carry the 'test_shipments.bulk_delete' permission — §10.2 grants it ✓ to
 * OWNER alone, so RolesGuard makes the whole surface Owner-only.
 * SessionGuard binds (shop_id, member_id) first (INV-1); every query is
 * scoped to req.session.shopId.
 *
 * Two-step flow: the GET names how many rows in which tables would go
 * (§9.5.7); the POST executes the irreversible delete and audits the
 * per-table counts (§12).
 */
@Controller('maintenance')
@UseGuards(SessionGuard, RolesGuard)
export class MaintenanceController {
  constructor(private readonly testShipments: TestShipmentsService) {}

  /** §9.5.7 step 1 — preview counts per table of the §5.3 carve-out set. */
  @Get('test-shipments/purge-preview')
  @RequiresPermission('test_shipments.bulk_delete')
  purgePreview(@Req() req: AuthenticatedRequest) {
    return this.testShipments.purgePreview(req.session.shopId);
  }

  /** §9.5.7 step 2 — irreversible bulk delete, audited with row counts. */
  @Post('test-shipments/delete')
  @RequiresPermission('test_shipments.bulk_delete')
  deleteTestShipments(@Req() req: AuthenticatedRequest) {
    return this.testShipments.purge(req.session.shopId, req.session.memberId);
  }
}
