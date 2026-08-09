import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from '../team/internal-token.guard';
import { SyncBackService } from './sync-back.service';

interface ReplayBody {
  outboxId?: string;
  adminId?: string;
}

/**
 * §3.17 / §8.6 DEAD replay, admin-only. Called by the platform admin surface
 * (admin.jsyxi.com DLQ replay, §9.13) through the internal-token boundary —
 * the same guard the team module uses for module-to-module calls. The replay
 * itself is audited with the acting admin's id (A1-10, §12).
 */
@Controller('internal/sync-back')
export class SyncBackController {
  constructor(private readonly syncBack: SyncBackService) {}

  @Post('replay')
  @UseGuards(InternalTokenGuard)
  async replay(@Body() body: ReplayBody): Promise<{ ok: true }> {
    await this.syncBack.replay(String(body.outboxId ?? ''), String(body.adminId ?? ''));
    return { ok: true };
  }
}
