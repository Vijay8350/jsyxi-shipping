import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RolesGuard } from '../team/rbac/roles.guard';
import { ReconExportService } from './recon-export.service';
import { ReconImportService, UploadBatchInput } from './recon-import.service';
import { ReconQueriesService } from './recon-queries.service';
import { ReconSettingsService } from './recon-settings.service';
import { ReconWorkflowService } from './recon-workflow.service';
import {
  FREIGHT_IMPORT_MAX_BYTES,
  ReconRowAction,
  ROW_TRANSITIONS,
  TaxTreatment,
} from './recon-freight.types';

/**
 * §9.17 freight reconciliation endpoints. SessionGuard establishes identity
 * (INV-1); RolesGuard authorizes against the §10.2 matrix — uploads and row
 * actions are Finance+ ('recon.edit'), residual acceptance is Finance+
 * ('recon.residual.accept'), settings are Finance+ ('settings.recon.edit'),
 * and reads are open to every authenticated member (§10.2 grants recon
 * read-only to Viewer). Structured failures return 422 (INV-20).
 *
 * The upload takes a raw `text/csv` body (§9.17.1 upload-only, RV-09) with
 * the §8.7 declared metadata as query parameters; Nest's JSON parser does
 * not consume text/csv, so the stream is read directly.
 */

/** Read the raw request body, capped just past the §5.1 size limit. */
async function readRawBody(req: AuthenticatedRequest): Promise<Buffer> {
  const preset = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (preset && preset.length > 0) return preset;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    chunks.push(buf);
    if (size > FREIGHT_IMPORT_MAX_BYTES + 1) break; // the service rejects it
  }
  return Buffer.concat(chunks);
}

interface RowActionBody {
  action?: ReconRowAction;
  remark?: string;
  expectedVersion?: number;
}

@Controller('recon/freight')
@UseGuards(SessionGuard, RolesGuard)
export class ReconFreightController {
  constructor(
    private readonly imports: ReconImportService,
    private readonly queries: ReconQueriesService,
    private readonly workflow: ReconWorkflowService,
    private readonly settings: ReconSettingsService,
    private readonly exports: ReconExportService,
  ) {}

  /** §9.17.1 upload (Finance+). Query params carry the §8.7 declarations. */
  @Post('batches')
  @RequiresPermission('recon.edit')
  async uploadBatch(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    const csvBytes = await readRawBody(req);
    const input: UploadBatchInput = {
      shopId: req.session.shopId,
      memberId: req.session.memberId,
      filename: (query.filename ?? 'invoice.csv').replace(/[^\w.-]+/g, '_'),
      csvBytes,
      courierAccountId: query.courierAccountId ?? '',
      columnMapId: query.columnMapId ?? '',
      declaredInvoiceTotal: query.declaredInvoiceTotal ?? '',
      taxTreatment: query.taxTreatment as TaxTreatment,
      invoiceReference: query.invoiceReference ?? '',
      invoiceDate: query.invoiceDate ?? '',
    };
    const result = await this.imports.upload(input);
    if (!result.ok) throw new UnprocessableEntityException(result);
    return result;
  }

  @Get('batches')
  listBatches(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.queries.listBatches(req.session.shopId, {
      state: query.state,
      courierAccountId: query.courierAccountId,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      offset: query.offset !== undefined ? Number(query.offset) : undefined,
    });
  }

  @Get('batches/:id')
  async getBatch(@Req() req: AuthenticatedRequest, @Param('id') batchId: string) {
    const batch = await this.queries.getBatch(req.session.shopId, batchId);
    if (!batch) throw new UnprocessableEntityException({ code: 'BATCH_NOT_FOUND' });
    return batch;
  }

  @Get('batches/:id/rows')
  listRows(
    @Req() req: AuthenticatedRequest,
    @Param('id') batchId: string,
    @Query() query: Record<string, string>,
  ) {
    const flag = (v: string | undefined) =>
      v === undefined ? undefined : v === 'true';
    return this.queries.listRows(req.session.shopId, {
      batchId,
      workflowState: query.workflowState,
      chargeType: query.chargeType,
      flagAwbNotFound: flag(query.flagAwbNotFound),
      flagWeightMismatch: flag(query.flagWeightMismatch),
      flagAmountMismatch: flag(query.flagAmountMismatch),
      flagReview: flag(query.flagReview),
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      offset: query.offset !== undefined ? Number(query.offset) : undefined,
    });
  }

  /** §9.17.2 row actions (Finance+): accept / dispute / submit / resolve / ignore. */
  @Post('rows/:id/actions')
  @HttpCode(200)
  @RequiresPermission('recon.edit')
  async rowAction(
    @Req() req: AuthenticatedRequest,
    @Param('id') rowId: string,
    @Body() body: RowActionBody,
  ) {
    if (!body?.action || !(body.action in ROW_TRANSITIONS)) {
      throw new UnprocessableEntityException({ ok: false, code: 'INVALID_ACTION' });
    }
    if (body.expectedVersion === undefined) {
      throw new UnprocessableEntityException({ ok: false, code: 'VERSION_REQUIRED' });
    }
    const result = await this.workflow.act({
      shopId: req.session.shopId,
      rowId,
      action: body.action,
      remark: body.remark,
      expectedVersion: body.expectedVersion,
      actorMemberId: req.session.memberId,
    });
    if (!result.ok) throw new UnprocessableEntityException(result);
    return result;
  }

  /** ADD-42: attach the courier's reweigh image object key (Finance+). */
  @Post('rows/:id/evidence')
  @HttpCode(200)
  @RequiresPermission('recon.edit')
  async attachEvidence(
    @Req() req: AuthenticatedRequest,
    @Param('id') rowId: string,
    @Body() body: { objectKey?: string; expectedVersion?: number },
  ) {
    if (!body?.objectKey || body.expectedVersion === undefined) {
      throw new UnprocessableEntityException({ ok: false, code: 'INVALID_EVIDENCE_REQUEST' });
    }
    if (!body.objectKey.startsWith(`shops/${req.session.shopId}/`)) {
      throw new UnprocessableEntityException({ ok: false, code: 'INVALID_OBJECT_KEY' });
    }
    const result = await this.workflow.attachEvidence({
      shopId: req.session.shopId,
      rowId,
      objectKey: body.objectKey,
      expectedVersion: body.expectedVersion,
      actorMemberId: req.session.memberId,
    });
    if (!result.ok) throw new UnprocessableEntityException(result);
    return result;
  }

  /** §3.28 residual acceptance (Finance+, remark mandatory). */
  @Post('batches/:id/residual-acceptance')
  @HttpCode(200)
  @RequiresPermission('recon.residual.accept')
  async acceptResidual(
    @Req() req: AuthenticatedRequest,
    @Param('id') batchId: string,
    @Body() body: { remark?: string; expectedVersion?: number },
  ) {
    if (!body?.remark || body.expectedVersion === undefined) {
      throw new UnprocessableEntityException({ ok: false, code: 'REMARK_AND_VERSION_REQUIRED' });
    }
    const result = await this.workflow.acceptResidual({
      shopId: req.session.shopId,
      batchId,
      remark: body.remark,
      expectedVersion: body.expectedVersion,
      actorMemberId: req.session.memberId,
    });
    if (!result.ok) throw new UnprocessableEntityException(result);
    return result;
  }

  /** §9.17.2 dispute export (Finance+) → S-26 signed URL. */
  @Post('disputes/export')
  @RequiresPermission('recon.edit')
  exportDisputes(
    @Req() req: AuthenticatedRequest,
    @Body() body: { batchId?: string },
  ) {
    return this.exports.exportDisputes({
      shopId: req.session.shopId,
      batchId: body?.batchId,
      actorMemberId: req.session.memberId,
    });
  }

  /** S-26 signed download of a dispute export (signature-verified). */
  @Get('exports/download')
  async downloadExport(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
  ) {
    const bytes = await this.exports.readExport({
      shopId: req.session.shopId,
      key: key ?? '',
      expires: Number(expires ?? '0'),
      signature: signature ?? '',
    });
    if (!bytes) throw new UnprocessableEntityException({ code: 'INVALID_OR_EXPIRED_URL' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="recon-disputes.csv"');
    res.send(bytes);
  }

  /** §9.17.4 settings read (any authenticated member). */
  @Get('settings')
  getSettings(@Req() req: AuthenticatedRequest) {
    return this.settings.get(req.session.shopId);
  }

  /** §9.17.4 S-27–S-30 write (Finance+), INV-22 checked. */
  @Put('settings')
  @RequiresPermission('settings.recon.edit')
  async updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() body: { expectedVersion?: number } & Record<string, unknown>,
  ) {
    if (body?.expectedVersion === undefined) {
      throw new UnprocessableEntityException({ ok: false, code: 'VERSION_REQUIRED' });
    }
    const { expectedVersion, ...patch } = body;
    const result = await this.settings.update(
      req.session.shopId,
      patch,
      expectedVersion,
      req.session.memberId,
    );
    if (!result.ok) throw new UnprocessableEntityException(result);
    return result;
  }

  /** §7.5 per-courier-account tolerance overrides (Finance+; null inherits). */
  @Put('settings/accounts/:courierAccountId')
  @RequiresPermission('settings.recon.edit')
  async updateAccountOverrides(
    @Req() req: AuthenticatedRequest,
    @Param('courierAccountId') courierAccountId: string,
    @Body() body: { expectedVersion?: number } & Record<string, unknown>,
  ) {
    if (body?.expectedVersion === undefined) {
      throw new UnprocessableEntityException({ ok: false, code: 'VERSION_REQUIRED' });
    }
    const { expectedVersion, ...patch } = body;
    const result = await this.settings.updateAccountOverrides(
      req.session.shopId,
      courierAccountId,
      patch,
      expectedVersion,
      req.session.memberId,
    );
    if (!result.ok) throw new UnprocessableEntityException(result);
    return result;
  }
}
