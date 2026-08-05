import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AsaasWebhookPayload } from './asaas/asaas.types';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingWebhookService, WebhookIngestResult } from './billing-webhook.service';

const TOKEN = 'token-secreto-do-webhook';

/** `configuredToken: null` simula a env ausente (não usar `undefined`: cai no default). */
function make(result: WebhookIngestResult = 'ok', configuredToken: string | null = TOKEN) {
  const config = { get: () => configuredToken ?? undefined } as unknown as ConfigService;
  const service = {
    handle: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<BillingWebhookService>;
  return { controller: new BillingWebhookController(config, service), service };
}

const payload = {
  id: 'evt_1',
  event: 'PAYMENT_RECEIVED',
  payment: { id: 'pay_1' },
} as AsaasWebhookPayload;

/**
 * Contrato de resposta ao Asaas (docs/cobranca-auditoria.md — B1). A regra é única e
 * inegociável: **só confirma o que está gravado**. O resto (falha de processamento)
 * vira fila local; confirmar sem gravar perderia o evento para sempre, porque o Asaas
 * nunca reenvia o que já deu 2xx.
 */
describe('BillingWebhookController', () => {
  it('sem ASAAS_WEBHOOK_TOKEN configurado responde 503 e não processa nada', async () => {
    const { controller, service } = make('ok', null);
    await expect(controller.handle(TOKEN, payload)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(service.handle).not.toHaveBeenCalled();
  });

  it('rejeita requisição sem token', async () => {
    const { controller, service } = make();
    await expect(controller.handle(undefined, payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.handle).not.toHaveBeenCalled();
  });

  it('rejeita token errado do mesmo tamanho', async () => {
    const { controller, service } = make();
    const wrong = 'x'.repeat(TOKEN.length);
    await expect(controller.handle(wrong, payload)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.handle).not.toHaveBeenCalled();
  });

  it('rejeita token de tamanho diferente sem estourar na comparação', async () => {
    // `timingSafeEqual` exige buffers do mesmo tamanho — por isso comparamos hashes.
    const { controller } = make();
    await expect(controller.handle('curto', payload)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.handle(TOKEN + 'sobra', payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('token certo e evento gravado → 200', async () => {
    const { controller, service } = make('ok');
    await expect(controller.handle(TOKEN, payload)).resolves.toEqual({
      received: true,
      result: 'ok',
    });
    expect(service.handle).toHaveBeenCalledWith(payload);
  });

  it('evento duplicado → 200 (já temos, não reenviar)', async () => {
    const { controller } = make('duplicate');
    await expect(controller.handle(TOKEN, payload)).resolves.toMatchObject({ received: true });
  });

  it('payload malformado → 200 (reenviar não resolveria)', async () => {
    const { controller } = make('invalid');
    await expect(controller.handle(TOKEN, payload)).resolves.toMatchObject({ received: true });
  });

  it('não conseguiu gravar → 503 para o Asaas reentregar (B1)', async () => {
    const { controller } = make('persist_failed');
    await expect(controller.handle(TOKEN, payload)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
