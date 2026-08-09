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
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest, SessionGuard } from '../../auth/session.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RolesGuard } from '../team/rbac/roles.guard';
import { GstInvoiceService } from './gst-invoice.service';
import {
  CreditNoteDto,
  ListInvoicesQueryDto,
  PatchInvoiceDto,
  VoidInvoiceDto,
} from './gst.dto';

/**
 * GST invoice endpoints (§9.9.2). SessionGuard establishes identity (INV-1);
 * RolesGuard authorizes against the §10.2 matrix. Issue/void/credit-note and
 * field supply are Finance+ acts ('gst_invoice.issue' — §10.2: "a tax
 * document is a finance act"); reads are open to any member with a session.
 */
@Controller('gst/invoices')
@UseGuards(SessionGuard, RolesGuard)
export class GstController {
  constructor(private readonly invoices: GstInvoiceService) {}

  /** List with state / missing-fields / created-at range filters (§11 feed). */
  @Get()
  list(@Req() req: AuthenticatedRequest, @Query() query: ListInvoicesQueryDto) {
    return this.invoices.listInvoices(req.session.shopId, {
      state: query.state,
      missingFieldsPresent: query.missingFieldsPresent === 'true',
      from: query.from,
      to: query.to,
    });
  }

  /** Full detail including lines. */
  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.getInvoice(req.session.shopId, id);
  }

  /** §9.9.2: supply missing fields; issue re-attempts automatically. */
  @Patch(':id')
  @RequiresPermission('gst_invoice.issue')
  patch(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchInvoiceDto,
  ) {
    return this.invoices.patchInvoice(req.session.shopId, id, req.session.memberId, dto);
  }

  /** §3.12: ISSUED → VOID (terminal), Finance+, mandatory reason, audited. */
  @Post(':id/void')
  @RequiresPermission('gst_invoice.issue')
  void(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
  ) {
    return this.invoices.voidInvoice(req.session.shopId, id, req.session.memberId, dto.reason);
  }

  /** INV-16: a correction is a NEW LINKED record, never an edit. */
  @Post(':id/credit-note')
  @RequiresPermission('gst_invoice.issue')
  creditNote(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditNoteDto,
  ) {
    return this.invoices.createCreditNote(req.session.shopId, id, req.session.memberId, dto.reason);
  }
}
