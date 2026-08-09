import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module';
import { OrdersReadService } from './orders-read.service';
import { OrdersController, ShipmentsListController } from './orders.controller';

/**
 * §9.2 read surfaces (order list, shipment list, order detail) for the merchant
 * console. DatabaseModule and AuthModule are global; TeamModule supplies the
 * §10.2 RolesGuard the controllers apply.
 */
@Module({
  imports: [TeamModule],
  controllers: [OrdersController, ShipmentsListController],
  providers: [OrdersReadService],
  exports: [OrdersReadService],
})
export class OrdersModule {}
