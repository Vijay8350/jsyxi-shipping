import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { DocumentsService } from './documents.service';

/**
 * Signed document downloads (S-26): HMAC-signed, 10-minute lifetime,
 * shop-scoped at download (INV-1). Re-download of an already-generated
 * document is allowed in RESTRICTED (§3.11) — no account-state check here.
 */
@Controller('documents')
@UseGuards(SessionGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id/download')
  async download(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param('id') documentId: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
  ) {
    const result = await this.documents.getDownload({
      shopId: req.session.shopId,
      documentId,
      expires: Number(expires ?? '0'),
      signature: signature ?? '',
    });
    if (result.kind === 'REDIRECT') {
      res.redirect(result.url);
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.bytes);
  }
}
