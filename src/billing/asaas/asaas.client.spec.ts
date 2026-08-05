import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { BillingAlertsService } from '../billing-alerts.service';
import { AsaasClient } from './asaas.client';
import { AsaasAccountError } from './asaas.errors';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const config = {
  get: (k: string) =>
    ({ ASAAS_API_URL: 'https://api-sandbox.asaas.com/v3', ASAAS_API_KEY: 'k' })[k],
} as unknown as ConfigService;

function make() {
  const alerts = {
    raise: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<BillingAlertsService>;
  return { client: new AsaasClient(config, alerts, logger), alerts };
}

/** Resposta HTTP de erro do Asaas, no formato real (`errors[].description`). */
function respondeErro(status: number, description?: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () =>
      Promise.resolve(
        JSON.stringify({ errors: description ? [{ code: 'invalid_object', description }] : [] }),
      ),
  }) as unknown as typeof fetch;
}

describe('AsaasClient — tratamento de erro', () => {
  beforeEach(() => jest.clearAllMocks());

  it('recusa por conta bloqueada vira 503 neutro + alerta para a operação', async () => {
    const { client, alerts } = make();
    respondeErro(400, 'A criação do checkout está desabilitada. Regularize a situação cadastral.');

    await expect(
      client.createCheckout({
        billingTypes: ['CREDIT_CARD'],
        chargeTypes: ['DETACHED'],
        callback: { successUrl: 'https://x/ok', cancelUrl: 'https://x/no' },
        items: [{ name: 'x', quantity: 1, value: 1 }],
      }),
    ).rejects.toBeInstanceOf(AsaasAccountError);

    expect(alerts.raise).toHaveBeenCalledWith(
      'provider_account_blocked',
      expect.objectContaining({ path: '/checkouts' }),
    );
  });

  it('erro de dados do cliente segue chegando até ele, com a mensagem do provedor', async () => {
    const { client, alerts } = make();
    respondeErro(400, 'CPF ou CNPJ inválido.');

    await expect(client.getPayment('pay_1')).rejects.toThrow('CPF ou CNPJ inválido.');
    await expect(client.getPayment('pay_1')).rejects.toBeInstanceOf(BadRequestException);
    // Erro do cliente não acorda ninguém de madrugada.
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('não repete o alerta a cada tentativa (conta bloqueada afeta todo mundo)', async () => {
    const { client, alerts } = make();
    respondeErro(400, 'A criação do checkout está desabilitada. Regularize a situação cadastral.');

    for (let i = 0; i < 5; i++) {
      await client.getPayment('pay_1').catch(() => null);
    }
    expect(alerts.raise).toHaveBeenCalledTimes(1);
  });

  it('falha ao alertar não muda o que o cliente recebe', async () => {
    const { client, alerts } = make();
    (alerts.raise as jest.Mock).mockRejectedValue(new Error('smtp fora'));
    respondeErro(400, 'Regularize a situação cadastral.');

    await expect(client.getPayment('pay_1')).rejects.toBeInstanceOf(AsaasAccountError);
  });

  it('erro que não é 400 continua como falha do provedor', async () => {
    const { client } = make();
    respondeErro(500, 'Internal error');

    await expect(client.getPayment('pay_1')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
