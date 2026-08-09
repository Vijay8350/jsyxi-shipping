import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionService } from './retention.service';
import { PartitionMaintenanceService } from './partition-maintenance.service';
import { TestShipmentsService } from './test-shipments.service';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceController } from './maintenance.controller';
import {
  LocalFilesystemObjectErase,
  OBJECT_ERASE,
} from '../health/object-erase';

/**
 * Retention & maintenance (§5.1 partition maintenance, §5.4 retention
 * sweep, §9.5.7 test-shipment bulk delete).
 *
 * Wiring notes for the parent:
 *  - Register MaintenanceModule in AppModule (this module may not edit it).
 *    DatabaseModule / RedisModule / AuditModule / ConfigModule are global.
 *  - OBJECT_ERASE reuses the §5.5 erasure seam from the health module
 *    (src/modules/health/object-erase.ts): bound here to the same local
 *    filesystem eraser rooted at the object-store dir. Once booking-ops
 *    ObjectStore gains a deleteObject method, rebind OBJECT_ERASE to the
 *    OBJECT_STORE instance (the seam's documented end state).
 *  - REQUIRED MIGRATION (shared change, not allowed from this module):
 *    migrations 0001–0017 predate the §5.3 carve-out and the §5.4 sweep.
 *    jsyxi_app currently lacks DELETE on booking_intent (revoked in 0003),
 *    tracking_event, tracking_event_raw (0010) and ndr_action (0014), and
 *    lacks DDL rights for ALTER TABLE … DETACH PARTITION / DROP TABLE on
 *    the tracking partitions. A follow-up migration must GRANT DELETE on
 *    those four tables to jsyxi_app (the carve-out makes those rows
 *    deletable) and either grant partition DDL to a maintenance role the
 *    sweep connects as, or schedule the sweep under the migration role.
 */
@Module({
  controllers: [MaintenanceController],
  providers: [
    RetentionService,
    PartitionMaintenanceService,
    TestShipmentsService,
    MaintenanceScheduler,
    MaintenanceProcessor,
    {
      provide: OBJECT_ERASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new LocalFilesystemObjectErase(
          config.get<string>('objectStoreDir') ??
            config.get<string>('OBJECT_STORE_DIR') ??
            'var/objects',
        ),
    },
  ],
  exports: [RetentionService, PartitionMaintenanceService, TestShipmentsService],
})
export class MaintenanceModule {}
