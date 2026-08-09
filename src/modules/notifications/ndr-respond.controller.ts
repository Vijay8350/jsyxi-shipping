import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Ip,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { NdrRespondService } from './ndr-respond.service';

/**
 * ADD-27 public buyer self-serve endpoints — NO session, by design (same
 * model as the track page: possession of the tokenized link is the
 * authorization). API-first JSON; the hosted frontend renders from it.
 *
 * Failure surface is uniform: any invalid/used/expired token is the same
 * 404 — never a hint about which part was wrong.
 */
@Controller('ndr')
export class NdrRespondController {
  constructor(private readonly respond: NdrRespondService) {}

  /** Page data: order ref, address on file, the four options. */
  @Get('respond/:token')
  async page(@Param('token') token: string) {
    const data = await this.respond.getPage(token);
    if (!data) throw new NotFoundException('This link is no longer valid.');
    return { ok: true, ...data };
  }

  @Post('respond/:token')
  @HttpCode(200)
  async submit(
    @Param('token') token: string,
    @Body() body: { response_type?: string; payload?: unknown },
    @Ip() ip: string,
  ) {
    const result = await this.respond.submit(
      token,
      body?.response_type ?? '',
      body?.payload ?? {},
      ip,
    );
    if (result.ok) return { ok: true, responseId: result.responseId };
    if (result.code === 'THROTTLED') {
      throw new HttpException(result.error ?? 'Too many attempts.', 429);
    }
    if (result.code === 'INVALID_RESPONSE') {
      throw new BadRequestException(result.error);
    }
    throw new NotFoundException(result.error ?? 'This link is no longer valid.');
  }
}
