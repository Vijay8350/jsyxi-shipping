import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Ip,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CodConfirmationService } from './cod-confirmation.service';

/**
 * ADD-28 public COD-confirmation endpoints — NO session (same tokenized-link
 * model as ADD-27 and the track page). Uniform 404 for any token that is not
 * PENDING — used, expired and unknown are indistinguishable.
 */
@Controller('cod')
export class CodConfirmController {
  constructor(private readonly confirmations: CodConfirmationService) {}

  /** Page data: order ref, COD amount, the confirm-by time. */
  @Get('confirm/:token')
  async page(@Param('token') token: string) {
    const data = await this.confirmations.getConfirmPage(token);
    if (!data) throw new NotFoundException('This link is no longer valid.');
    return { ok: true, ...data };
  }

  @Post('confirm/:token')
  @HttpCode(200)
  async confirm(@Param('token') token: string, @Ip() ip: string) {
    const result = await this.confirmations.confirm(token, ip);
    if (result.throttled) {
      throw new HttpException('Too many attempts. Please try again later.', 429);
    }
    if (!result.ok) throw new NotFoundException('This link is no longer valid.');
    return { ok: true };
  }
}
