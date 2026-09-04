import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
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
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<PinoLogger>;
  return { controller: new BillingWebhookController(config, service, logger), service, logger };
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

  /**
   * O token vai para arquivo de config no copiar-e-colar, e um espaço invisível no fim
   * derrubava a comparação — 401 em todo evento, fila do Asaas interrompida em 15
   * falhas, eventos represados apagados em 14 dias. Aparamos os DOIS lados.
   */
  it('token certo com espaço no fim → 200 (os dois lados são aparados)', async () => {
    const { controller, service } = make();
    await expect(controller.handle(`${TOKEN}  `, payload)).resolves.toMatchObject({
      received: true,
    });
    expect(service.handle).toHaveBeenCalled();
  });

  it('config com espaço no fim também casa', async () => {
    const { controller } = make('ok', `${TOKEN}   `);
    await expect(controller.handle(TOKEN, payload)).resolves.toMatchObject({ received: true });
  });

  /**
   * Sem este log, um 401 não distingue token errado, header ausente e token truncado —
   * e a explicação do painel do Asaas culpa firewall. Com ele a causa aparece na
   * primeira tentativa. Prefixo e tamanho bastam: o token inteiro nunca vai para o log.
   */
  it('token recusado loga prefixo e tamanho dos dois lados, nunca o token inteiro', async () => {
    const { controller, logger } = make();
    await expect(controller.handle('outro-token-qualquer', payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const [contexto] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(contexto).toMatchObject({
      headerPresente: true,
      recebido: 'outro-',
      recebidoLen: 'outro-token-qualquer'.length,
      esperado: TOKEN.slice(0, 6),
      esperadoLen: TOKEN.length,
    });
    expect(JSON.stringify(contexto)).not.toContain(TOKEN);
  });

  it('header ausente aparece como tal no log — é cadastro sem authToken no painel', async () => {
    const { controller, logger } = make();
    await expect(controller.handle(undefined, payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ headerPresente: false, recebidoLen: 0 });
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
