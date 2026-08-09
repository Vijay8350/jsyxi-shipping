import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { LabelTemplateService } from './label-template.service';
import { BulkLabelsService } from './bulk-labels.service';
import { LabelGenerateGuard, LabelTemplateOwnerGuard } from './labels.guards';
import { LABEL_SIZES, LabelSize, LabelToggles } from './labels.types';

interface TemplatePatchBody {
  brandName?: string | null;
  supportPhone?: string | null;
  messageLine?: string | null;
  logoObjectKey?: string | null;
  toggles?: Partial<LabelToggles>;
  size?: LabelSize;
  version?: number;
}

interface BulkBody {
  shipmentIds?: string[];
}

/**
 * §9.12 label & invoice customization (S-23/S-24) and the §9.9.1 bulk label
 * jobs. Template reads and job-status reads are available to every
 * authenticated role; template changes are Owner-only (§7.4) and job
 * creation is Operator+ / Finance (§10.2) — enforced by the local guards.
 * INV-22: template writes carry the version the writer read.
 */
@Controller('labels')
@UseGuards(SessionGuard)
export class LabelsController {
  constructor(
    private readonly templates: LabelTemplateService,
    private readonly bulk: BulkLabelsService,
  ) {}

  /** First read creates the row with the S-23/S-24 defaults. */
  @Get('template')
  async getTemplate(@Req() req: AuthenticatedRequest) {
    return this.templates.getOrCreate(req.session.shopId);
  }

  @Patch('template')
  @UseGuards(LabelTemplateOwnerGuard)
  async patchTemplate(@Req() req: AuthenticatedRequest, @Body() body: TemplatePatchBody) {
    if (typeof body?.version !== 'number') {
      // INV-22: every write carries the version the writer read.
      throw new BadRequestException('version is required (INV-22)');
    }
    if (body.size !== undefined && !LABEL_SIZES.includes(body.size)) {
      throw new BadRequestException(`unknown label size (S-23): ${body.size}`);
    }
    return this.templates.update(req.session.shopId, req.session.memberId, {
      brandName: body.brandName,
      supportPhone: body.supportPhone,
      messageLine: body.messageLine,
      logoObjectKey: body.logoObjectKey,
      toggles: body.toggles,
      size: body.size,
      version: body.version,
    });
  }

  /** §9.9.1 bulk merged label PDF (≤1,000 shipments, §5.1). */
  @Post('bulk')
  @UseGuards(LabelGenerateGuard)
  async createBulk(@Req() req: AuthenticatedRequest, @Body() body: BulkBody) {
    return this.bulk.createBulkJob({
      shopId: req.session.shopId,
      actorId: req.session.memberId,
      shipmentIds: body?.shipmentIds ?? [],
      bulkKind: 'BULK',
    });
  }

  /**
   * ADD-36 bulk label reprint — same document_job shape as bulk, regenerated
   * from the frozen snapshots (INV-8).
   */
  @Post('bulk-reprint')
  @UseGuards(LabelGenerateGuard)
  async createBulkReprint(@Req() req: AuthenticatedRequest, @Body() body: BulkBody) {
    return this.bulk.createBulkJob({
      shopId: req.session.shopId,
      actorId: req.session.memberId,
      shipmentIds: body?.shipmentIds ?? [],
      bulkKind: 'REPRINT',
    });
  }

  /** §9.9.1 job progress, result and skipped report. Shop-scoped (INV-1). */
  @Get('jobs/:jobId')
  async getJob(@Req() req: AuthenticatedRequest, @Param('jobId') jobId: string) {
    return this.bulk.getJob(req.session.shopId, jobId);
  }
}
