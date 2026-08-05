import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'crypto';
import { Public } from '../auth/decorators/public.decorator';
import type { AsaasWebhookPayload } from './asaas/asaas.types';
import { BillingWebhookService } from './billing-webhook.service';
import { SkipBillingGate } from './decorators/skip-billing-gate.decorator';

/** Compara segredos em tempo constante (hash para igualar o tamanho). */
function secretsMatch(received: string, expected: string): boolean {
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Endpoint público do webhook do Asaas, autenticado pelo header `asaas-access-token`
 * (o mesmo configurado no painel).
 *
 * Contrato de resposta (docs/cobranca-auditoria.md — B1):
 * - **200** só depois de o evento estar **gravado**. Falha de processamento não
 *   impede o 200: o evento fica na fila de reprocessamento local.
 * - **503** quando não conseguimos gravar — assim o Asaas **reentrega** (a fila dele
 *   guarda 14 dias). Confirmar sem gravar perderia o evento para sempre.
 *
 * Sem throttle: depois de uma fila interrompida o Asaas drena o acúmulo em ordem
 * cronológica; um 429 aqui contaria como falha e interromperia a fila de novo.
 */
@Public()
@SkipBillingGate()
@SkipThrottle()
@Controller('billing/webhook')
export class BillingWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly webhookService: BillingWebhookService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handle(
    @Headers('asaas-access-token') token: string | undefined,
    @Body() payload: AsaasWebhookPayload,
  ) {
    const expected = this.config.get<string>('ASAAS_WEBHOOK_TOKEN');
    if (!expected) {
      throw new ServiceUnavailableException('Webhook não configurado');
    }
    if (!token || !secretsMatch(token, expected)) {
      throw new UnauthorizedException('Token de webhook inválido');
    }

    const result = await this.webhookService.handle(payload);
    if (result === 'persist_failed') {
      throw new ServiceUnavailableException('Não foi possível registrar o evento — reenvie');
    }
    return { received: true, result };
  }
}
