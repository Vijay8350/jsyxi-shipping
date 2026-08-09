import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RolesGuard } from '../team/rbac/roles.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { TestView } from '../dashboard/dashboard.types';
import { OrdersReadService } from './orders-read.service';

/**
 * §9.2 read surfaces for the merchant console: the order and shipment lists
 * plus order detail. Read-only — booking, cancelling and labelling stay in
 * their own modules behind their own §10.2 permissions.
 *
 * `orders.view` is the §10.2 row for both lists; a shipment is only ever
 * reachable through the order it belongs to, so it carries no separate row.
 * SessionGuard binds (shop_id, member_id) first (INV-1).
 */

/** §9.23: test/live defaults to LIVE; only an explicit 'test' opts out. */
function parseView(view: string | undefined): TestView {
  return view === 'test' ? 'test' : 'live';
}

function parseInt10(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** Blank strings arrive from empty query params; treat them as absent. */
function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

@Controller('orders')
@UseGuards(SessionGuard, RolesGuard)
@RequiresPermission('orders.view')
export class OrdersController {
  constructor(private readonly orders: OrdersReadService) {}

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('view') view?: string,
    @Query('state') state?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.orders.listOrders({
      shopId: req.session.shopId,
      view: parseView(view),
      state: trimmed(state),
      search: trimmed(search),
      limit: parseInt10(limit),
      offset: parseInt10(offset),
    });
  }

  @Get(':orderId')
  async detail(@Req() req: AuthenticatedRequest, @Param('orderId') orderId: string) {
    const order = await this.orders.getOrder(req.session.shopId, orderId);
    // Another shop's order is indistinguishable from a missing one (INV-1).
    if (!order) throw new NotFoundException({ status: 'ORDER_NOT_FOUND' });
    return order;
  }
}

/**
 * The shipment list. Separate controller because it owns a different route
 * prefix; `/shipments/:id/*` action routes live in the booking, labels and
 * rules modules, which Nest composes with this one.
 */
@Controller('shipments')
@UseGuards(SessionGuard, RolesGuard)
@RequiresPermission('orders.view')
export class ShipmentsListController {
  constructor(private readonly orders: OrdersReadService) {}

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('view') view?: string,
    @Query('state') state?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.orders.listShipments({
      shopId: req.session.shopId,
      view: parseView(view),
      state: trimmed(state),
      search: trimmed(search),
      limit: parseInt10(limit),
      offset: parseInt10(offset),
    });
  }
}
