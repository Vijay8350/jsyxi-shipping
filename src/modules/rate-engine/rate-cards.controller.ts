import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { FinancePlusGuard } from './finance-plus.guard';
import { RateCardsService } from './rate-cards.service';
import { validateRateCardCsv } from './rate-card-csv';
import {
  CreateRateCardDto,
  CreateRateCardVersionDto,
  CsvConfirmDto,
  CsvValidateDto,
  SealDto,
} from './rate-engine.dto';

/**
 * Rate card endpoints (§9.15). SessionGuard establishes identity (INV-1) on
 * every route; writes additionally require Finance+ (§10.2 "Create / edit
 * rate cards and zone maps" — Owner or Finance). Reads are open to every
 * role (Viewer is R on the same §10.2 row).
 */
@Controller('rate-cards')
@UseGuards(SessionGuard)
export class RateCardsController {
  constructor(private readonly rateCards: RateCardsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query('serviceId') serviceId?: string) {
    return this.rateCards.listCards(req.session.shopId, serviceId);
  }

  @Post()
  @UseGuards(FinancePlusGuard)
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateRateCardDto) {
    return this.rateCards.createRateCard(req.session.shopId, req.session.memberId, dto);
  }

  @Get(':rateCardId/versions')
  listVersions(
    @Req() req: AuthenticatedRequest,
    @Param('rateCardId', ParseUUIDPipe) rateCardId: string,
  ) {
    return this.rateCards.listVersions(req.session.shopId, rateCardId);
  }

  @Post(':rateCardId/versions')
  @UseGuards(FinancePlusGuard)
  createVersion(
    @Req() req: AuthenticatedRequest,
    @Param('rateCardId', ParseUUIDPipe) rateCardId: string,
    @Body() dto: CreateRateCardVersionDto,
  ) {
    return this.rateCards.createVersion(req.session.shopId, req.session.memberId, rateCardId, {
      ...dto,
      effectiveTo: dto.effectiveTo ?? null,
      rtoPct: dto.rtoPct ?? null,
    });
  }

  /** INV-11 seal — also called by the booking module via the service. */
  @Post('versions/:rateCardVersionId/seal')
  @UseGuards(FinancePlusGuard)
  seal(
    @Req() req: AuthenticatedRequest,
    @Param('rateCardVersionId', ParseUUIDPipe) rateCardVersionId: string,
    @Body() dto: SealDto,
  ) {
    return this.rateCards.seal(
      req.session.shopId,
      req.session.memberId,
      rateCardVersionId,
      dto.version,
    );
  }

  /** §9.15 CSV step 1: parse + validate every row, return the preview. */
  @Post('csv/validate')
  @UseGuards(FinancePlusGuard)
  validateCsv(@Body() dto: CsvValidateDto) {
    return validateRateCardCsv(dto.csv);
  }

  /** §9.15 CSV step 2: re-validate and persist as a new version. */
  @Post(':rateCardId/versions/csv/confirm')
  @UseGuards(FinancePlusGuard)
  confirmCsv(
    @Req() req: AuthenticatedRequest,
    @Param('rateCardId', ParseUUIDPipe) rateCardId: string,
    @Body() dto: CsvConfirmDto,
  ) {
    const { csv, ...versionInput } = dto;
    return this.rateCards.confirmCsvUpload(
      req.session.shopId,
      req.session.memberId,
      rateCardId,
      { ...versionInput, effectiveTo: dto.effectiveTo ?? null, rtoPct: dto.rtoPct ?? null },
      csv,
    );
  }
}
