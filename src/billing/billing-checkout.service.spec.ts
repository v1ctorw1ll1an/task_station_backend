import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { BillingCharge, Subscription } from '../generated/prisma/client';
import { AsaasClient } from './asaas/asaas.client';
import type { AsaasPayment, AsaasSubscription } from './asaas/asaas.types';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingRepository } from './billing.repository';

const CHARGE_ID = '11111111-2222-3333-4444-555555555555';
const CUSTOMER = 'cus_1';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const config = {
  get: (_k: string, d?: string) => d,
} as unknown as ConfigService;

const charge = {
  id: CHARGE_ID,
  companyId: 'c1',
  amountCents: 43092,
  seatAddonId: null,
  createdAt: new Date('2026-09-01T12:00:00Z'),
} as unknown as BillingCharge;

const sub = {
  id: 'sub_1',
  companyId: 'c1',
  asaasCustomerId: CUSTOMER,
  asaasSubscriptionId: null,
} as unknown as Subscription;

function make(asaas: Partial<AsaasClient>, repo: Partial<BillingRepository> = {}) {
  const client = asaas as unknown as jest.Mocked<AsaasClient>;
  const repository = {
    findSubscriptionByCompany: jest.fn().mockResolvedValue(sub),
    findSeatAddons: jest.fn().mockResolvedValue([]),
    findChargeByAsaasPaymentId: jest.fn().mockResolvedValue(null),
    findSeatAddonById: jest.fn().mockResolvedValue(null),
    updateCharge: jest.fn(),
    ...repo,
  } as unknown as jest.Mocked<BillingRepository>;
  return {
    service: new BillingCheckoutService(client, repository, config, logger),
    asaas: client,
    repo: repository,
  };
}

const assinatura = (externalReference?: string): AsaasSubscription =>
  ({
    id: 'sub_asaas_1',
    status: 'ACTIVE',
    value: 430.92,
    cycle: 'YEARLY',
    externalReference,
  }) as AsaasSubscription;

/**
 * A conta Asaas é compartilhada com outros produtos, e as referências gravadas antes do
 * namespace continuam voltando com a grafia velha para sempre. Estes dois caminhos leem
 * `externalReference` de volta da Asaas: quebrá-los não dá erro nenhum — só deixa de
 * vincular a assinatura/cobrança, em silêncio.
 */
describe('BillingCheckoutService — leitura do externalReference', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('resolverAssinatura', () => {
    it('casa a assinatura pela referência COM namespace', async () => {
      const { service } = make({
        listCustomerSubscriptions: jest
          .fn()
          .mockResolvedValue({ data: [assinatura(`taskdy:${CHARGE_ID}`)] }),
      });
      await expect(service.resolverAssinatura(charge, sub, 'YEARLY')).resolves.toBe('sub_asaas_1');
    });

    it('casa também a referência crua das assinaturas criadas antes do namespace', async () => {
      const { service } = make({
        listCustomerSubscriptions: jest.fn().mockResolvedValue({ data: [assinatura(CHARGE_ID)] }),
      });
      await expect(service.resolverAssinatura(charge, sub, 'YEARLY')).resolves.toBe('sub_asaas_1');
    });

    it('referência de outro produto não casa nem pelo valor idêntico', async () => {
      // Duas candidatas com o mesmo valor: a de outro produto não pode ser adotada pela
      // referência, e o desempate por valor se recusa a adivinhar. Resultado: nada.
      const { service } = make({
        listCustomerSubscriptions: jest.fn().mockResolvedValue({
          data: [assinatura('outro:99'), assinatura('outro:100')],
        }),
      });
      await expect(service.resolverAssinatura(charge, sub, 'YEARLY')).resolves.toBeNull();
    });
  });

  describe('casarPagamento', () => {
    const pagamento = { id: 'pay_1', value: 430.92 } as AsaasPayment;

    it('procura primeiro pela referência namespeada', async () => {
      const listPayments = jest.fn().mockResolvedValue({ data: [pagamento] });
      const { service } = make({ listPayments });

      await expect(service.casarPagamento(charge, sub)).resolves.toBe(pagamento);
      expect(listPayments).toHaveBeenCalledWith({
        customer: CUSTOMER,
        externalReference: `taskdy:${CHARGE_ID}`,
      });
      expect(listPayments).toHaveBeenCalledTimes(1);
    });

    it('cai no id cru quando a namespeada não acha nada (cobrança anterior ao deploy)', async () => {
      // O filtro da API do Asaas bate string EXATA: sem este fallback, o "Já paguei" de
      // toda cobrança criada antes do namespace pararia de casar.
      const listPayments = jest
        .fn()
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [pagamento] });
      const { service } = make({ listPayments });

      await expect(service.casarPagamento(charge, sub)).resolves.toBe(pagamento);
      expect(listPayments).toHaveBeenNthCalledWith(2, {
        customer: CUSTOMER,
        externalReference: CHARGE_ID,
      });
    });

    it('duas candidatas na mesma referência continuam sem vincular nada', async () => {
      const listPayments = jest.fn().mockResolvedValue({ data: [pagamento, pagamento] });
      const { service } = make({
        listPayments,
        listSubscriptionPayments: jest.fn().mockResolvedValue({ data: [] }),
      });
      // Cai para o último recurso (cliente + valor + janela), que também vê duas.
      await expect(service.casarPagamento(charge, sub)).resolves.toBeNull();
    });
  });
});
