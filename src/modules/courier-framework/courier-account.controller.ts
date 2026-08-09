import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest, SessionGuard } from '../../auth/session.guard';
import { CourierAccountService } from './courier-account.service';
import { CourierCatalogService } from './courier-catalog.service';
import { CourierRequestService } from './courier-request.service';
import {
  ConnectAccountDto,
  CourierRequestDto,
  ReplaceCredentialsDto,
  SetEnabledDto,
  SetMerchantServiceDto,
  SwitchModeDto,
} from './courier-framework.dto';
import { MerchantServicesService } from './merchant-services.service';
import { OwnerGuard } from './owner.guard';

/**
 * Courier connect & account management (§9.3.3) + ADD-18 webhook
 * management. SessionGuard establishes identity (INV-1); account mutations
 * are Owner-only via the local OwnerGuard. The catalog endpoints
 * (`GET /couriers`) are safe for any authenticated role — they expose only
 * global master data and never credential values (INV-18).
 */
@Controller()
@UseGuards(SessionGuard)
export class CourierAccountController {
  constructor(
    private readonly catalog: CourierCatalogService,
    private readonly accounts: CourierAccountService,
    private readonly services: MerchantServicesService,
    private readonly requests: CourierRequestService,
  ) {}

  /** §9.3.3: couriers with credential-field schema (public fields only),
   *  capabilities and guides — the connect form's data source. */
  @Get('couriers')
  listCouriers() {
    return this.catalog.listCouriers();
  }

  /** §9.3.5: request-a-courier demand counter. */
  @Post('courier-requests')
  requestCourier(@Req() req: AuthenticatedRequest, @Body() dto: CourierRequestDto) {
    return this.requests.request(req.session.shopId, dto.courierNameText);
  }

  @Get('courier-accounts')
  @UseGuards(OwnerGuard)
  listAccounts(@Req() req: AuthenticatedRequest) {
    return this.accounts.listAccounts(req.session.shopId);
  }

  @Post('courier-accounts')
  @UseGuards(OwnerGuard)
  connect(@Req() req: AuthenticatedRequest, @Body() dto: ConnectAccountDto) {
    return this.accounts.connectAccount(req.session.shopId, req.session.memberId, dto);
  }

  /** §9.3.3: real test-connection call; UNVERIFIED → HEALTHY (§3.21). */
  @Post('courier-accounts/:accountId/test-connection')
  @UseGuards(OwnerGuard)
  testConnection(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.accounts.testConnection(req.session.shopId, accountId);
  }

  /** RW-20: switch mode; the other mode's credentials survive untouched. */
  @Post('courier-accounts/:accountId/mode')
  @UseGuards(OwnerGuard)
  switchMode(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: SwitchModeDto,
  ) {
    return this.accounts.switchMode(req.session.shopId, req.session.memberId, accountId, dto.mode);
  }

  /** §5.7 control 3: the replace action — write-only, masked display back. */
  @Post('courier-accounts/:accountId/credentials')
  @UseGuards(OwnerGuard)
  replaceCredentials(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: ReplaceCredentialsDto,
  ) {
    return this.accounts.replaceCredentials(
      req.session.shopId,
      req.session.memberId,
      accountId,
      dto.credentials,
    );
  }

  @Post('courier-accounts/:accountId/enabled')
  @UseGuards(OwnerGuard)
  setEnabled(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: SetEnabledDto,
  ) {
    return this.accounts.setEnabled(
      req.session.shopId,
      req.session.memberId,
      accountId,
      dto.enabled,
    );
  }

  /** §9.3.2: merchant services on the account. */
  @Get('courier-accounts/:accountId/services')
  @UseGuards(OwnerGuard)
  listServices(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.services.list(req.session.shopId, accountId);
  }

  @Put('courier-accounts/:accountId/services')
  @UseGuards(OwnerGuard)
  setService(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: SetMerchantServiceDto,
  ) {
    return this.services.setService(
      req.session.shopId,
      accountId,
      dto.serviceId,
      dto.enabled,
      dto.priorityTiebreakOrder,
    );
  }

  // ------------------------------------------------------------------
  // ADD-18 — webhook management surface
  // ------------------------------------------------------------------

  @Get('courier-accounts/:accountId/webhook')
  @UseGuards(OwnerGuard)
  getWebhookManagement(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.accounts.getWebhookManagement(req.session.shopId, accountId);
  }

  /** ADD-18: regenerate the signing secret — separate audited action. */
  @Post('courier-accounts/:accountId/webhook/secret')
  @UseGuards(OwnerGuard)
  regenerateSecret(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.accounts.regenerateSecret(req.session.shopId, req.session.memberId, accountId);
  }

  /** ADD-18: regenerate the URL token — old URL stops working immediately. */
  @Post('courier-accounts/:accountId/webhook/url-token')
  @UseGuards(OwnerGuard)
  regenerateUrlToken(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.accounts.regenerateUrlToken(req.session.shopId, req.session.memberId, accountId);
  }

  /** ADD-18: the adapter's fake event POSTed to the account's webhook path. */
  @Post('courier-accounts/:accountId/webhook/test-event')
  @UseGuards(OwnerGuard)
  sendTestEvent(
    @Req() req: AuthenticatedRequest,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.accounts.sendTestEvent(req.session.shopId, accountId);
  }
}
