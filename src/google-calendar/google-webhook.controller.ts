import {
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Public } from '../auth/decorators/public.decorator';
import { SkipBillingGate } from '../billing/decorators/skip-billing-gate.decorator';
import { GoogleCalendarConnectionService } from './google-calendar-connection.service';

/**
 * Notificação push do Google (`events.watch`). Não traz o evento — só avisa que o
 * calendário mudou; validamos canal + token e enfileiramos a leitura, respondendo
 * rápido (o Google reenvia em erro e desiste de canais lentos).
 */
@Public()
@SkipBillingGate()
@Controller('integrations/google/webhook')
export class GoogleWebhookController {
  constructor(
    private readonly connections: GoogleCalendarConnectionService,
    @InjectPinoLogger(GoogleWebhookController.name)
    private readonly logger: PinoLogger,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  // Por IP: o Google agrupa notificações, rajada legítima é pequena.
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async handle(
    @Headers('x-goog-channel-id') channelId: string | undefined,
    @Headers('x-goog-channel-token') token: string | undefined,
    @Headers('x-goog-resource-state') resourceState: string | undefined,
  ) {
    const result = await this.connections.handleWebhook(channelId, token, resourceState);
    if (result === 'forbidden') {
      this.logger.warn({ channelPresent: !!channelId }, 'Webhook do Google com token inválido');
      throw new ForbiddenException();
    }
    // Canal desconhecido (já trocado/parado): 404 e o Google deixa de insistir quando expira.
    if (result === 'unknown') throw new NotFoundException();
    return { received: true };
  }
}
