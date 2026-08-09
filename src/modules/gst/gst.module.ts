import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module';
import { GstInvoiceService } from './gst-invoice.service';
import { GstController } from './gst.controller';

/**
 * GST invoice module (§9.9.2, §3.12). DatabaseModule, AuthModule and
 * AuditModule are @Global, so PG_POOL, SessionService/SessionGuard and
 * AuditService inject without imports; RolesGuard comes from the team
 * module's §10.2 catalog. GstInvoiceService is exported so the booking
 * worker can call onShipmentConfirmed at CONFIRMED (the §9.9.2 seam).
 */
@Module({
  imports: [TeamModule],
  controllers: [GstController],
  providers: [GstInvoiceService],
  exports: [GstInvoiceService],
})
export class GstModule {}
