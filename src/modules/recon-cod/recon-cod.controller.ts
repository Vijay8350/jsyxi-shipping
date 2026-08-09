import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RolesGuard } from '../team/rbac/roles.guard';
import { CodImportService } from './cod-import.service';
import { CodQueryService, ExpectationFilters } from './cod-query.service';
import { CodSettingsService } from './cod-settings.service';
import { CodReconQueueService } from './recon-cod-queue';
import type { CodBatchState, CodExpectedState } from './recon-cod.types';

interface UploadBatchBody {
  filename?: string;
  contentBase64?: string;
  courierAccountId?: string;
  columnMapId?: string | null;
  remittanceReference?: string | null;
  remittanceDate?: string | null;
  declaredTotal?: string | null;
}

interface CodSettingsPatchBody {
  codEnabled?: boolean;
  codTolerance?: string;
  codDueDays?: number;
  version?: number;
}

/**
 * §9.17.3 COD reconciliation endpoints.
 *
 * **INV-23 money boundary: this screen records money that moved between the
 * courier and the merchant. Jsyxi is not a party to it** — there is no
 * payout action, no balance, no settlement to the merchant and no holding of
 * remitted cash anywhere in this module. Matching a remittance changes a
 * Jsyxi record and nothing else.
 *
 * SessionGuard establishes identity (INV-1); RolesGuard authorizes writes
 * against the §10.2 matrix: upload is 'recon.edit' (Finance+), settings are
 * 'settings.recon.edit' (Finance+). Reads are open to every authenticated
 * role — Viewer is R on the same §10.2 row (rate-engine precedent).
 */
@Controller('recon/cod')
@UseGuards(SessionGuard, RolesGuard)
export class ReconCodController {
  constructor(
    private readonly importer: CodImportService,
    private readonly queries: CodQueryService,
    private readonly settings: CodSettingsService,
    private readonly queue: CodReconQueueService,
  ) {}

  /** §9.17.1: upload-only (RV-09). INV-14: same-hash re-upload is a no-op. */
  @Post('batches')
  @RequiresPermission('recon.edit')
  async uploadBatch(@Req() req: AuthenticatedRequest, @Body() body: UploadBatchBody) {
    if (!body.filename || !body.contentBase64 || !body.courierAccountId) {
      throw new UnprocessableEntityException(
        'filename, contentBase64 and courierAccountId are required (§8.7)',
      );
    }
    const result = await this.importer.uploadBatch({
      shopId: req.session.shopId,
      actorMemberId: req.session.memberId,
      filename: body.filename,
      contentBase64: body.contentBase64,
      courierAccountId: body.courierAccountId,
      columnMapId: body.columnMapId ?? null,
      remittanceReference: body.remittanceReference ?? null,
      remittanceDate: body.remittanceDate ?? null,
      declaredTotal: body.declaredTotal ?? null,
    });
    if (!result.idempotent) {
      const text = Buffer.from(body.contentBase64, 'base64').toString('utf8');
      await this.queue.stageFile(req.session.shopId, result.batch.cod_batch_id, text);
      await this.queue.enqueueBatchProcessing({
        shopId: req.session.shopId,
        batchId: result.batch.cod_batch_id,
      });
    }
    return result;
  }

  @Get('batches')
  listBatches(
    @Req() req: AuthenticatedRequest,
    @Query('state') state?: CodBatchState,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listBatches(req.session.shopId, {
      state,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('batches/:batchId')
  getBatch(@Req() req: AuthenticatedRequest, @Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.queries.getBatch(req.session.shopId, batchId);
  }

  /** Feeds the §11 COD_PENDING report (expected/allocated/balance/due/aging/state). */
  @Get('expectations')
  listExpectations(
    @Req() req: AuthenticatedRequest,
    @Query('state') state?: CodExpectedState,
    @Query('courierAccountId') courierAccountId?: string,
    @Query('minAgingDays') minAgingDays?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const filters: ExpectationFilters = {
      state,
      courierAccountId,
      minAgingDays: minAgingDays != null ? Number(minAgingDays) : undefined,
      dueFrom,
      dueTo,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    };
    return this.queries.listExpectations(req.session.shopId, filters);
  }

  @Get('summary')
  summary(@Req() req: AuthenticatedRequest) {
    return this.queries.summary(req.session.shopId);
  }

  /** §9.17.4: S-29/S-30 read. */
  @Get('settings')
  getSettings(@Req() req: AuthenticatedRequest) {
    return this.settings.get(req.session.shopId);
  }

  /** §9.17.4: S-29/S-30 write (Finance+). INV-22 version-checked, audited. */
  @Patch('settings')
  @RequiresPermission('settings.recon.edit')
  updateSettings(@Req() req: AuthenticatedRequest, @Body() body: CodSettingsPatchBody) {
    if (body.version == null) {
      throw new UnprocessableEntityException('version is required (INV-22)');
    }
    return this.settings.update(
      req.session.shopId,
      {
        codEnabled: body.codEnabled,
        codTolerance: body.codTolerance,
        codDueDays: body.codDueDays,
      },
      body.version,
      req.session.memberId,
    );
  }
}
