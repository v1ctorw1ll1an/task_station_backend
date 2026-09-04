import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { MailerService } from '../mailer/mailer.service';
import { AsaasClient } from './asaas/asaas.client';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';
import { PreviewMethod } from './dto/billing-preview-query.dto';
import {
  ANNUAL_SEAT_CENTS,
  annualTotalCents,
  MAX_SEATS,
  MONTHLY_BASE_CENTS,
  MONTHLY_EXTRA_SEAT_CENTS,
  monthlyTotalCents,
} from './pricing';

/** Perfil de cobrança completo — pré-requisito de qualquer pagamento. */
const PERFIL_COMPLETO = {
  billingName: 'Fulano de Tal',
  billingEmail: 'f@t.com',
  billingCpfCnpj: '12345678909',
  billingPostalCode: '01001000',
  billingStreet: 'Praça da Sé',
  billingAddressNumber: '10',
  billingAddressComplement: null,
  billingNeighborhood: 'Sé',
  billingCity: 'São Paulo',
  billingState: 'SP',
  billingPhone: '11987654321',
};

/**
 * Data relativa ao "agora". Fixture de ciclo aberto precisa ser relativa: uma data
 * fixa no futuro vira passado com o tempo e quebra o teste sozinha.
 */
function emDias(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

function makeSub(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'sub-uuid',
    companyId: 'company-1',
    status: 'trial',
    method: null,
    purchasedSeats: 1,
    addonSeats: 0,
    seatsAtNextRenewal: null,
    asaasCustomerId: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    ...PERFIL_COMPLETO,
    ...overrides,
  };
}

function makeRepo(sub: any): jest.Mocked<BillingRepository> {
  return {
    findSubscriptionByCompany: jest.fn().mockResolvedValue(sub),
    updateSubscription: jest.fn().mockResolvedValue(sub),
    countOccupiedSeats: jest.fn().mockResolvedValue(1),
    findCompanySeatHolders: jest
      .fn()
      .mockResolvedValue([{ userId: 'dono', role: 'admin', scheduledRemovalAt: null }]),
    scheduleSeatRemovals: jest.fn().mockResolvedValue(undefined),
    applyScheduledSeatRemovals: jest.fn().mockResolvedValue({ count: 0 }),
    getCompanyFiscal: jest
      .fn()
      .mockResolvedValue({ legalName: 'ACME', taxId: '12345678000199', adminEmail: 'a@b.com' }),
    createCharge: jest.fn().mockResolvedValue({ id: 'charge-1' }),
    updateCharge: jest.fn().mockResolvedValue({ id: 'charge-1' }),
    findCharges: jest.fn().mockResolvedValue([[], 0]),
    findPendingPixCharge: jest.fn().mockResolvedValue(null),
    findPendingChargesByCompany: jest.fn().mockResolvedValue([]),
    findOpenChargeByIntent: jest.fn().mockResolvedValue(null),
    findChargeById: jest.fn().mockResolvedValue(null),
    findLatestPendingCharge: jest.fn().mockResolvedValue(null),
    findCompanyByTaxIdExcluding: jest.fn().mockResolvedValue(null),
    updateCompanyFiscal: jest.fn().mockResolvedValue({}),
    findCompanyAdminEmails: jest.fn().mockResolvedValue(['admin@co.com']),
    findSubscriptionById: jest.fn().mockResolvedValue(sub),
    findChargeByCheckoutId: jest.fn().mockResolvedValue(null),
    findChargeByAsaasPaymentId: jest.fn().mockResolvedValue(null),
    createSeatAddon: jest.fn().mockResolvedValue({ id: 'addon-1', seats: 1 }),
    updateSeatAddon: jest.fn().mockResolvedValue({ id: 'addon-1' }),
    findSeatAddonById: jest.fn().mockResolvedValue(null),
    findSeatAddons: jest.fn().mockResolvedValue([]),
    sumActiveAddonSeats: jest.fn().mockResolvedValue(0),
    syncAddonSeats: jest.fn().mockResolvedValue(0),
    // O lock é exclusão mútua no Postgres; no unit test executa a seção direto.
    withCompanyLock: jest
      .fn()
      .mockImplementation((_companyId: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as jest.Mocked<BillingRepository>;
}

function makeAsaas(): jest.Mocked<AsaasClient> {
  return {
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_1' }),
    updateCustomer: jest.fn().mockResolvedValue({ id: 'cus_1' }),
    createCheckout: jest
      .fn()
      .mockResolvedValue({ id: 'chk_1', link: 'https://asaas/chk_1', status: 'ACTIVE' }),
    cancelCheckout: jest.fn().mockResolvedValue({ id: 'chk_1', status: 'CANCELED' }),
    getSubscription: jest.fn().mockResolvedValue({ id: 'asub_1', status: 'ACTIVE' }),
    listPayments: jest.fn().mockResolvedValue({ data: [] }),
    createSubscription: jest.fn().mockResolvedValue({ id: 'asub_1', status: 'ACTIVE' }),
    updateSubscriptionValue: jest.fn().mockResolvedValue({ id: 'asub_1' }),
    deleteSubscription: jest.fn().mockResolvedValue({ deleted: true }),
    deletePayment: jest.fn().mockResolvedValue({ deleted: true }),
    listSubscriptionPayments: jest.fn().mockResolvedValue({ data: [] }),
    listCustomerSubscriptions: jest.fn().mockResolvedValue({ data: [] }),
    createPayment: jest
      .fn()
      .mockResolvedValue({ id: 'pay_1', status: 'PENDING', invoiceUrl: 'http://inv' }),
    getPayment: jest.fn(),
    getPixQrCode: jest.fn().mockResolvedValue({
      encodedImage: 'img',
      payload: '000201',
      expirationDate: '2026-07-22 23:59:59',
    }),
  } as unknown as jest.Mocked<AsaasClient>;
}

function makeWebhook(): jest.Mocked<BillingWebhookService> {
  return {
    reconcilePayment: jest.fn().mockResolvedValue(undefined),
    reconcileSubscription: jest.fn().mockResolvedValue(undefined),
    repairStuckActivation: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<BillingWebhookService>;
}

function makeMailer(): jest.Mocked<MailerService> {
  return {
    sendSeatPixEmail: jest.fn().mockResolvedValue(undefined),
    sendPaymentConfirmedEmail: jest.fn().mockResolvedValue(undefined),
    sendPaymentFailedEmail: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailerService>;
}

function makeConfig(enabled = true): ConfigService {
  const map: Record<string, string> = {
    BILLING_ENABLED: enabled ? 'true' : 'false',
    // Zero: parcelar não encarece (R36/R45) — é o valor de produção.
    BILLING_ANNUAL_INTEREST_MONTHLY: '0',
    ASAAS_API_URL: 'https://api-sandbox.asaas.com/v3',
    ASAAS_API_KEY: 'key',
    FRONTEND_URL: 'https://app.taskdy.test',
  };
  return { get: (k: string, d?: string) => map[k] ?? d } as unknown as ConfigService;
}

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

function makeService(sub: any, enabled = true) {
  const repo = makeRepo(sub);
  const asaas = makeAsaas();
  const webhook = makeWebhook();
  const mailer = makeMailer();
  const config = makeConfig(enabled);
  // Checkout real (só o cliente Asaas é dublê): é ele que decide reaproveitar link e
  // recusar vínculo ambíguo, e testar o serviço com um dublê disso esconderia a regra.
  const checkout = new BillingCheckoutService(asaas, repo, config, logger);
  const service = new BillingService(repo, asaas, config, webhook, checkout, mailer, logger);
  return { service, repo, asaas, webhook, mailer, checkout };
}

describe('BillingService', () => {
  describe('getPreview', () => {
    it('mensal usa o preço mensal', () => {
      const { service } = makeService(makeSub());
      expect(service.getPreview({ seats: 3, method: PreviewMethod.monthly })).toMatchObject({
        totalCents: 8970,
        installments: 1,
      });
    });

    it('anual-pix aplica o desconto anual', () => {
      const { service } = makeService(makeSub());
      expect(service.getPreview({ seats: 1, method: PreviewMethod.annual_pix })).toMatchObject({
        totalCents: 44910,
      });
    });

    it('anual-cartão inclui juros e devolve o valor da parcela', () => {
      const { service } = makeService(makeSub());
      const r = service.getPreview({
        seats: 1,
        method: PreviewMethod.annual_card,
        installments: 3,
      });
      expect(r.installments).toBe(3);
      expect(r.totalCents).toBeGreaterThanOrEqual(44910);
      expect(r).toHaveProperty('installmentCents');
    });
  });

  describe('subscribeMonthly', () => {
    it('devolve o link do checkout e não cria assinatura nenhuma no Asaas', async () => {
      const { service, repo, asaas } = makeService(makeSub());
      const r = await service.subscribeMonthly('company-1', {});

      expect(asaas.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ cpfCnpj: '12345678000199', externalReference: 'company-1' }),
      );
      expect(asaas.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          billingTypes: ['CREDIT_CARD'],
          chargeTypes: ['RECURRENT'],
          customer: 'cus_1',
          subscription: expect.objectContaining({ cycle: 'MONTHLY' }),
        }),
      );
      // Quem cria a assinatura é o checkout, do lado do Asaas — daí não chamarmos a
      // API de assinaturas aqui nem gravarmos `asaasSubscriptionId` ainda.
      expect(asaas.createSubscription).not.toHaveBeenCalled();
      expect(r.checkoutUrl).toBe('https://asaas/chk_1');
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ method: 'monthly_card' }),
      );
    });

    it('a cobrança nasce pendente, com o valor do plano', async () => {
      const { service, repo } = makeService(makeSub());
      await service.subscribeMonthly('company-1', { seats: 3 });

      expect(repo.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'subscription',
          status: 'pending',
          paymentKind: 'credit_card',
          amountCents: monthlyTotalCents(3),
          seats: 3,
        }),
      );
    });

    it('reaproveita o customer Asaas existente', async () => {
      const { service, asaas } = makeService(makeSub({ asaasCustomerId: 'cus_existing' }));
      await service.subscribeMonthly('company-1', {});
      expect(asaas.createCustomer).not.toHaveBeenCalled();
      expect(asaas.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing' }),
      );
    });

    it('nunca manda `customerData` junto do `customer` (a API recusa os dois)', async () => {
      const { service, asaas } = makeService(makeSub({ asaasCustomerId: 'cus_1' }));
      await service.subscribeMonthly('company-1', {});
      const body = asaas.createCheckout.mock.calls[0][0];
      expect(body).not.toHaveProperty('customerData');
    });

    it('falha quando a cobrança está desabilitada', async () => {
      const { service, asaas } = makeService(makeSub(), false);
      await expect(service.subscribeMonthly('company-1', {})).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(asaas.createCheckout).not.toHaveBeenCalled();
    });

    it('exige os dados de cobrança antes de mandar o cliente para o Asaas', async () => {
      const { service, asaas } = makeService(makeSub({ billingCity: null }));
      await expect(service.subscribeMonthly('company-1', {})).rejects.toMatchObject({
        response: { code: 'BILLING_PROFILE_INCOMPLETE' },
      });
      expect(asaas.createCheckout).not.toHaveBeenCalled();
    });

    it('recusa assinar por cima de um cancelamento agendado (o caminho é Reativar)', async () => {
      const { service, asaas } = makeService(
        makeSub({ status: 'active', method: 'monthly_card', cancelAtPeriodEnd: true }),
      );
      await expect(service.subscribeMonthly('company-1', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(asaas.createCheckout).not.toHaveBeenCalled();
    });

    it('com ciclo pago aberto, contrata o PRÓXIMO ciclo em vez de cobrar duas vezes (R47)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'annual_pix',
        asaasCustomerId: 'cus_1',
        currentPeriodEnd: new Date('2099-01-10T00:00:00Z'),
      });
      const { service, asaas } = makeService(sub);
      await service.subscribeMonthly('company-1', {});

      // A 1ª cobrança do plano novo cai no fim do que já foi pago — nada agora.
      expect(asaas.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription: expect.objectContaining({ nextDueDate: '2099-01-09' }),
        }),
      );
    });

    it('assinatura nova não herda o cancelamento da anterior (C1)', async () => {
      // Cancelou, o ciclo acabou (`canceled`) e agora contrata de novo: se a flag
      // sobrevivesse, o cron cancelaria o plano novo no fim do primeiro ciclo.
      const { service, repo } = makeService(
        makeSub({
          status: 'canceled',
          cancelAtPeriodEnd: true,
          canceledAt: new Date('2026-07-01T00:00:00Z'),
        }),
      );
      await service.subscribeMonthly('company-1', {});
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub-uuid', {
        cancelAtPeriodEnd: false,
        canceledAt: null,
      });
    });

    it('encerra recorrência remanescente antes de assinar um plano novo (B2)', async () => {
      const { service, asaas } = makeService(
        makeSub({ status: 'past_due', method: 'monthly_card', asaasSubscriptionId: 'asub_velha' }),
      );
      await service.subscribeAnnualPix('company-1');
      expect(asaas.deleteSubscription).toHaveBeenCalledWith('asub_velha');
    });
  });

  describe('subscribeAnnualPix', () => {
    it('cria a assinatura anual, anexa o QR da 1ª cobrança e marca o método', async () => {
      const { service, repo, asaas } = makeService(makeSub());
      asaas.listSubscriptionPayments.mockResolvedValue({
        object: 'list',
        hasMore: false,
        totalCount: 1,
        data: [{ id: 'pay_1', status: 'PENDING', invoiceUrl: 'http://inv' }],
      } as never);
      await service.subscribeAnnualPix('company-1');

      expect(repo.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({ paymentKind: 'pix', amountCents: 44910, status: 'pending' }),
      );
      // Virou assinatura nativa: o Asaas gera a cobrança de cada ano sozinho.
      expect(asaas.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ billingType: 'PIX', cycle: 'YEARLY', value: 449.1 }),
      );
      expect(asaas.createPayment).not.toHaveBeenCalled();
      expect(asaas.getPixQrCode).toHaveBeenCalledWith('pay_1');
      // B5: o id do pagamento é gravado ANTES de buscar o QR (cobrança nunca fica órfã).
      expect(repo.updateCharge).toHaveBeenNthCalledWith(
        1,
        'charge-1',
        expect.objectContaining({ asaasPaymentId: 'pay_1' }),
      );
      expect(repo.updateCharge).toHaveBeenNthCalledWith(
        2,
        'charge-1',
        expect.objectContaining({ pixPayload: '000201' }),
      );
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ method: 'annual_pix' }),
      );
    });

    it('reaproveita o Pix pendente válido em vez de gerar uma segunda cobrança (B2)', async () => {
      const { service, repo, asaas } = makeService(makeSub());
      repo.findOpenChargeByIntent.mockResolvedValue({
        id: 'charge-antiga',
        // `seats` é NOT NULL no schema — a cobrança aberta sempre sabe por quantos
        // assentos foi criada, e o reaproveitamento compara justamente isso.
        seats: 1,
        paymentKind: 'pix',
        pixPayload: '000201',
        pixExpiresAt: new Date(Date.now() + 3_600_000),
        metadata: { method: 'annual_pix' },
      } as never);

      await service.subscribeAnnualPix('company-1');

      expect(repo.createCharge).not.toHaveBeenCalled();
      expect(asaas.createPayment).not.toHaveBeenCalled();
    });

    it('cancela a cobrança aberta de outro método antes de criar a nova (B2)', async () => {
      const { service, repo, asaas } = makeService(makeSub());
      repo.findOpenChargeByIntent.mockResolvedValue({
        id: 'charge-cartao',
        paymentKind: 'credit_card',
        asaasPaymentId: 'pay_old',
        metadata: { method: 'annual_card' },
      } as never);

      await service.subscribeAnnualPix('company-1');

      expect(asaas.deletePayment).toHaveBeenCalledWith('pay_old');
      expect(repo.updateCharge).toHaveBeenCalledWith('charge-cartao', { status: 'canceled' });
      expect(repo.createCharge).toHaveBeenCalled();
    });

    it('Asaas recusando a assinatura marca a cobrança como falha (B5)', async () => {
      const { service, repo, asaas } = makeService(makeSub());
      asaas.createSubscription.mockRejectedValue(new Error('documento inválido'));

      await expect(service.subscribeAnnualPix('company-1')).rejects.toThrow('documento inválido');
      // A cobrança nasce antes (é ela que trava o duplo clique), mas não fica pendurada
      // como se houvesse algo a pagar.
      expect(repo.updateCharge).toHaveBeenCalledWith(
        'charge-1',
        expect.objectContaining({ status: 'failed', failReason: 'documento inválido' }),
      );
    });

    it('QR indisponível na hora não derruba a contratação (a conciliação resolve)', async () => {
      const { service, repo, asaas } = makeService(makeSub());
      asaas.listSubscriptionPayments.mockRejectedValue(new Error('ainda não gerada'));

      await expect(service.subscribeAnnualPix('company-1')).resolves.toBeDefined();
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ method: 'annual_pix', asaasSubscriptionId: 'asub_1' }),
      );
    });
  });

  describe('subscribeAnnualCard', () => {
    it('abre um checkout parcelado — o cliente escolhe as parcelas na página do Asaas', async () => {
      const { service, repo, asaas } = makeService(makeSub());
      await service.subscribeAnnualCard('company-1', { installments: 3 });

      expect(repo.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({ paymentKind: 'credit_card', installments: 3 }),
      );
      expect(asaas.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          chargeTypes: ['INSTALLMENT'],
          installment: { maxInstallmentCount: 3 },
        }),
      );
      expect(asaas.createPayment).not.toHaveBeenCalled();
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ method: 'annual_card' }),
      );
      // Segurança: nem a subscription nem o charge guardam dados do cartão.
      const savedAnnual = repo.updateSubscription.mock.calls[0][1];
      expect(savedAnnual).not.toHaveProperty('asaasCardToken');
      const savedCharge = repo.createCharge.mock.calls[0][0];
      expect(savedCharge).not.toHaveProperty('cardLastFour');
      expect(savedCharge).not.toHaveProperty('cardBrand');
    });
  });

  describe('assertSeatAvailable', () => {
    it('cortesia é isenta de verdade (acesso total)', async () => {
      const { service } = makeService(makeSub({ status: 'courtesy', purchasedSeats: 1 }));
      await expect(service.assertSeatAvailable('company-1')).resolves.toBeUndefined();
    });

    it('trial NÃO dá assento de graça — assento ocupado bloqueia com convite a assinar (C14)', async () => {
      const sub = makeSub({ status: 'trial', purchasedSeats: 1 });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(1);
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig();
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await expect(service.assertSeatAvailable('company-1')).rejects.toThrow(/Assine um plano/);
    });

    it('trial com assento livre segue liberando', async () => {
      const sub = makeSub({ status: 'trial', purchasedSeats: 2 });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(1);
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig();
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await expect(service.assertSeatAvailable('company-1')).resolves.toBeUndefined();
    });

    it('bloqueia quando todos os assentos comprados estão ocupados', async () => {
      const sub = makeSub({ status: 'active', purchasedSeats: 2 });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(2);
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig();
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await expect(service.assertSeatAvailable('company-1')).rejects.toThrow(/em uso/);
    });

    it('marca o erro com code SEAT_LIMIT (contrato com a tela, que oferece os planos)', async () => {
      const sub = makeSub({ status: 'active', purchasedSeats: 1 });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(1);
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig();
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );

      // O front decide mostrar o link "Ver planos" por este código, e não pelo texto
      // da mensagem — casar por texto quebraria na primeira revisão de copy.
      await expect(service.assertSeatAvailable('company-1')).rejects.toMatchObject({
        response: { code: 'SEAT_LIMIT' },
      });
    });

    it('libera quando há assento disponível', async () => {
      const sub = makeSub({ status: 'active', purchasedSeats: 3 });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(2);
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig();
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await expect(service.assertSeatAvailable('company-1')).resolves.toBeUndefined();
    });

    it('não bloqueia com billing desligado', async () => {
      const sub = makeSub({ status: 'active', purchasedSeats: 1 });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(5);
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig(false);
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await expect(service.assertSeatAvailable('company-1')).resolves.toBeUndefined();
    });
  });

  describe('buySeats', () => {
    /** Assinatura mensal vigente, com ciclo aberto. */
    function mensalAtiva(overrides: Record<string, unknown> = {}) {
      return makeSub({
        status: 'active',
        method: 'monthly_card',
        purchasedSeats: 2,
        asaasCustomerId: 'cus_1',
        asaasSubscriptionId: 'asub_1',
        currentPeriodStart: emDias(-20),
        currentPeriodEnd: emDias(10),
        ...overrides,
      });
    }

    function anualAtiva(overrides: Record<string, unknown> = {}) {
      return makeSub({
        status: 'active',
        method: 'annual_pix',
        purchasedSeats: 2,
        asaasCustomerId: 'cus_1',
        currentPeriodStart: emDias(-60),
        currentPeriodEnd: emDias(305),
        ...overrides,
      });
    }

    describe('mensal', () => {
      it('cobra o valor cheio numa cobrança avulsa e devolve o checkout', async () => {
        const { service, repo, asaas } = makeService(mensalAtiva());
        const r = await service.buySeats('company-1', { quantity: 2 });

        expect(repo.createCharge).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'seat',
            status: 'pending',
            amountCents: 2 * MONTHLY_EXTRA_SEAT_CENTS,
            seatsDelta: 2,
            paymentKind: 'credit_card',
          }),
        );
        expect(asaas.createCheckout).toHaveBeenCalledWith(
          expect.objectContaining({ chargeTypes: ['DETACHED'] }),
        );
        expect(r.checkoutUrl).toBe('https://asaas/chk_1');
      });

      it('no Pix gera o QR e não abre checkout', async () => {
        const { service, asaas } = makeService(mensalAtiva());
        const r = await service.buySeats('company-1', { quantity: 1, paymentKind: 'pix' });

        expect(asaas.createPayment).toHaveBeenCalledWith(
          expect.objectContaining({ billingType: 'PIX', value: 19.9 }),
        );
        expect(asaas.getPixQrCode).toHaveBeenCalledWith('pay_1');
        expect(asaas.createCheckout).not.toHaveBeenCalled();
        expect(r.checkoutUrl).toBeNull();
      });

      it('NÃO libera o assento nem mexe na recorrência antes do pagamento', async () => {
        const { service, repo, asaas } = makeService(mensalAtiva());
        await service.buySeats('company-1', { quantity: 1 });

        for (const [, data] of repo.updateSubscription.mock.calls) {
          expect(data).not.toHaveProperty('purchasedSeats');
        }
        expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled();
      });

      it('não cria uma segunda compra com uma já em aberto (B2)', async () => {
        const { service, repo } = makeService(mensalAtiva());
        repo.findOpenChargeByIntent.mockResolvedValue({ id: 'chg_aberta' } as never);
        await expect(service.buySeats('company-1', { quantity: 1 })).rejects.toBeInstanceOf(
          ConflictException,
        );
      });
    });

    describe('anual', () => {
      it('cria uma assinatura de assentos própria, de um ano cheio', async () => {
        const { service, repo } = makeService(anualAtiva());
        await service.buySeats('company-1', { quantity: 3, paymentKind: 'pix' });

        expect(repo.createSeatAddon).toHaveBeenCalledWith(
          expect.objectContaining({
            seats: 3,
            unitPriceCents: ANNUAL_SEAT_CENTS,
            amountCents: 3 * ANNUAL_SEAT_CENTS,
            status: 'pending',
          }),
        );
      });

      it('no Pix a assinatura YEARLY nasce já, para o QR existir', async () => {
        const { service, asaas, repo } = makeService(anualAtiva());
        asaas.listSubscriptionPayments.mockResolvedValue({
          object: 'list',
          hasMore: false,
          totalCount: 1,
          data: [{ id: 'pay_addon', status: 'PENDING', invoiceUrl: 'http://inv' }],
        } as never);

        await service.buySeats('company-1', { quantity: 1, paymentKind: 'pix' });

        expect(asaas.createSubscription).toHaveBeenCalledWith(
          expect.objectContaining({ billingType: 'PIX', cycle: 'YEARLY', value: 179.1 }),
        );
        expect(repo.updateSeatAddon).toHaveBeenCalledWith(
          'addon-1',
          expect.objectContaining({ asaasSubscriptionId: 'asub_1' }),
        );
        expect(asaas.getPixQrCode).toHaveBeenCalledWith('pay_addon');
      });

      it('no cartão quem cria a assinatura é o checkout (RECURRENT anual)', async () => {
        const { service, asaas } = makeService(anualAtiva());
        const r = await service.buySeats('company-1', { quantity: 1, paymentKind: 'credit_card' });

        expect(asaas.createCheckout).toHaveBeenCalledWith(
          expect.objectContaining({
            chargeTypes: ['RECURRENT'],
            subscription: expect.objectContaining({ cycle: 'YEARLY' }),
          }),
        );
        expect(asaas.createSubscription).not.toHaveBeenCalled();
        expect(r.checkoutUrl).toBe('https://asaas/chk_1');
      });

      it('a cobrança do assento fica ligada ao add-on', async () => {
        const { service, repo } = makeService(anualAtiva());
        await service.buySeats('company-1', { quantity: 1, paymentKind: 'pix' });

        expect(repo.createCharge).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'seat', seatAddonId: 'addon-1' }),
        );
      });
    });

    describe('guardas', () => {
      it('exige plano assinado', async () => {
        const { service } = makeService(makeSub());
        await expect(service.buySeats('company-1', { quantity: 1 })).rejects.toThrow(
          /Assine um plano/,
        );
      });

      it('exige assinatura vigente (C3)', async () => {
        const { service } = makeService(mensalAtiva({ status: 'past_due' }));
        await expect(service.buySeats('company-1', { quantity: 1 })).rejects.toThrow(/Regularize/);
      });

      it('exige ciclo não vencido', async () => {
        const { service } = makeService(
          mensalAtiva({ currentPeriodEnd: new Date('2020-01-01T00:00:00Z') }),
        );
        await expect(service.buySeats('company-1', { quantity: 1 })).rejects.toThrow(/vencido/);
      });

      it('exige os dados de cobrança completos', async () => {
        const { service } = makeService(mensalAtiva({ billingState: null }));
        await expect(service.buySeats('company-1', { quantity: 1 })).rejects.toMatchObject({
          response: { code: 'BILLING_PROFILE_INCOMPLETE' },
        });
      });

      it('serializa a operação por empresa (duplo clique não vira duas compras)', async () => {
        const { service, repo } = makeService(mensalAtiva());
        await service.buySeats('company-1', { quantity: 1 });
        expect(repo.withCompanyLock).toHaveBeenCalledWith('company-1', expect.any(Function));
      });
    });
  });

  describe('reduceSeats', () => {
    it('agenda a redução para a próxima renovação', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        purchasedSeats: 3,
        asaasSubscriptionId: 'asub_1',
      });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(1);
      const asaas = makeAsaas();
      const cfg = makeConfig(true);
      const service = new BillingService(
        repo,
        asaas,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaas, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await service.reduceSeats('company-1', { quantity: 1 });

      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ seatsAtNextRenewal: 2 }),
      );
      expect(asaas.updateSubscriptionValue).toHaveBeenCalledWith('asub_1', 69.8);
    });

    it('rejeita reduzir sem assinatura vigente (C3)', async () => {
      // Mensal (onde a operação existe), mas fora de um ciclo pago.
      const sub = makeSub({ status: 'readonly', method: 'monthly_card', purchasedSeats: 3 });
      const { service, repo } = makeService(sub);
      await expect(service.reduceSeats('company-1', { quantity: 1 })).rejects.toThrow(/vigente/);
      expect(repo.updateSubscription).not.toHaveBeenCalled();
    });

    it('rejeita reduzir abaixo dos assentos ocupados', async () => {
      const sub = makeSub({ status: 'active', method: 'monthly_card', purchasedSeats: 3 });
      const repo = makeRepo(sub);
      repo.countOccupiedSeats.mockResolvedValue(3);
      repo.findCompanySeatHolders.mockResolvedValue([
        { userId: 'dono', role: 'admin', scheduledRemovalAt: null },
        { userId: 'u2', role: 'member', scheduledRemovalAt: null },
        { userId: 'u3', role: 'member', scheduledRemovalAt: null },
      ] as never);
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig();
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        makeWebhook(),
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await expect(service.reduceSeats('company-1', { quantity: 1 })).rejects.toThrow(
        /Selecione mais/,
      );
    });
  });

  describe('cancel', () => {
    it('agenda o cancelamento no fim do ciclo e encerra a recorrência no Asaas (mensal)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        asaasSubscriptionId: 'asub_1',
        currentPeriodEnd: new Date('2026-08-10T00:00:00Z'),
      });
      const { service, repo, asaas } = makeService(sub);
      await service.cancel('company-1');

      expect(asaas.deleteSubscription).toHaveBeenCalledWith('asub_1');
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ cancelAtPeriodEnd: true, asaasSubscriptionId: null }),
      );
    });

    it('anual (sem recorrência nativa) só agenda o cancelamento', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'annual_pix',
        asaasSubscriptionId: null,
        currentPeriodEnd: emDias(120),
      });
      const { service, repo, asaas } = makeService(sub);
      await service.cancel('company-1');

      expect(asaas.deleteSubscription).not.toHaveBeenCalled();
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ cancelAtPeriodEnd: true }),
      );
    });

    it('é idempotente quando já estava agendado (não chama o Asaas de novo)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        asaasSubscriptionId: 'asub_1',
        cancelAtPeriodEnd: true,
      });
      const { service, repo, asaas } = makeService(sub);
      await service.cancel('company-1');

      expect(asaas.deleteSubscription).not.toHaveBeenCalled();
      expect(repo.updateSubscription).not.toHaveBeenCalled();
    });

    it('rejeita cancelar quando não há assinatura vigente', async () => {
      const { service, asaas } = makeService(makeSub({ status: 'trial' }));
      await expect(service.cancel('company-1')).rejects.toThrow(/vigente/);
      expect(asaas.deleteSubscription).not.toHaveBeenCalled();
    });

    it('em carência (past_due) o cancelamento encerra a recorrência no Asaas (C9)', async () => {
      const sub = makeSub({
        status: 'past_due',
        method: 'monthly_card',
        asaasSubscriptionId: 'asub_1',
        currentPeriodEnd: new Date('2026-07-20T00:00:00Z'),
      });
      const { service, repo, asaas } = makeService(sub);

      await service.cancel('company-1');

      expect(asaas.deleteSubscription).toHaveBeenCalledWith('asub_1');
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ cancelAtPeriodEnd: true, asaasSubscriptionId: null }),
      );
    });

    it('falha quando a cobrança está desabilitada', async () => {
      const { service } = makeService(makeSub({ status: 'active' }), false);
      await expect(service.cancel('company-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('reactivate', () => {
    it('anual: apenas limpa o cancelamento agendado (sem cartão, sem tocar no Asaas)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'annual_pix',
        cancelAtPeriodEnd: true,
        asaasSubscriptionId: null,
      });
      const { service, repo, asaas } = makeService(sub);
      await service.reactivate('company-1');

      expect(asaas.createSubscription).not.toHaveBeenCalled();
      expect(asaas.createCheckout).not.toHaveBeenCalled();
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub-uuid', {
        cancelAtPeriodEnd: false,
      });
    });

    it('mensal: abre um checkout novo, cobrando só no fim do período já pago', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        cancelAtPeriodEnd: true,
        asaasSubscriptionId: null,
        asaasCustomerId: 'cus_1',
        purchasedSeats: 1,
        currentPeriodEnd: new Date('2026-08-10T12:00:00Z'),
      });
      const { service, repo, asaas } = makeService(sub);
      const r = await service.reactivate('company-1');

      // O cartão vive no Asaas: reativar é informá-lo lá, não aqui.
      expect(asaas.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          chargeTypes: ['RECURRENT'],
          subscription: expect.objectContaining({ cycle: 'MONTHLY', nextDueDate: '2026-08-10' }),
        }),
      );
      expect(r.checkoutUrl).toBe('https://asaas/chk_1');
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ cancelAtPeriodEnd: false }),
      );
    });

    it('mensal: exige os dados de cobrança antes de abrir o checkout', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        cancelAtPeriodEnd: true,
        asaasSubscriptionId: null,
        asaasCustomerId: 'cus_1',
        currentPeriodEnd: new Date('2026-08-10T12:00:00Z'),
        billingNeighborhood: null,
      });
      const { service, asaas } = makeService(sub);
      await expect(service.reactivate('company-1')).rejects.toMatchObject({
        response: { code: 'BILLING_PROFILE_INCOMPLETE' },
      });
      expect(asaas.createCheckout).not.toHaveBeenCalled();
    });

    it('rejeita quando não há cancelamento agendado', async () => {
      const { service } = makeService(makeSub({ status: 'active', cancelAtPeriodEnd: false }));
      await expect(service.reactivate('company-1')).rejects.toThrow(/reativar/);
    });

    it('falha quando a cobrança está desabilitada', async () => {
      const { service } = makeService(
        makeSub({ status: 'active', cancelAtPeriodEnd: true }),
        false,
      );
      await expect(service.reactivate('company-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  /**
   * Antes disto a primeira contratação era sempre pelos assentos que a empresa já
   * tinha — na prática, o assento único do trial. Quem entrava com time de 8 pessoas
   * assinava para 1 e tinha de comprar 7 assentos logo depois.
   */
  describe('escolha de assentos na contratação', () => {
    it('mensal: cobra a recorrência pela quantidade escolhida e grava os assentos', async () => {
      const { service, repo } = makeService(makeSub({ status: 'trial' }));

      await service.subscribeMonthly('company-1', { seats: 5 });

      expect(repo.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: monthlyTotalCents(5) }),
      );
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ method: 'monthly_card', purchasedSeats: 5 }),
      );
    });

    it('anual-pix: a cobrança sai pelo valor da quantidade escolhida', async () => {
      const { service, repo } = makeService(makeSub({ status: 'trial' }));

      await service.subscribeAnnualPix('company-1', { seats: 4 });

      expect(repo.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({ seats: 4, amountCents: annualTotalCents(4) }),
      );
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({ method: 'annual_pix', purchasedSeats: 4 }),
      );
    });

    it('sem escolha explícita, mantém os assentos que a empresa já tem', async () => {
      const { service, repo } = makeService(makeSub({ status: 'trial', purchasedSeats: 3 }));

      await service.subscribeAnnualPix('company-1');

      expect(repo.createCharge).toHaveBeenCalledWith(expect.objectContaining({ seats: 3 }));
    });

    it('recusa contratar menos assentos do que gente já dentro da empresa', async () => {
      const { service, repo } = makeService(makeSub({ status: 'trial', purchasedSeats: 6 }));
      repo.countOccupiedSeats.mockResolvedValue(6);

      await expect(service.subscribeAnnualPix('company-1', { seats: 2 })).rejects.toThrow(
        /ao menos 6 usuário/,
      );
      expect(repo.createCharge).not.toHaveBeenCalled();
    });

    it('com plano vigente, mudar assento é compra com proração — não pelo checkout', async () => {
      const { service, repo } = makeService(
        makeSub({ status: 'active', method: 'annual_pix', purchasedSeats: 3 }),
      );

      await expect(service.subscribeAnnualPix('company-1', { seats: 9 })).rejects.toThrow(
        /compra de usuários/,
      );
      expect(repo.createCharge).not.toHaveBeenCalled();
    });

    it('Pix aberto por outra quantidade não é reaproveitado (cobraria o valor errado)', async () => {
      const { service, repo, asaas } = makeService(makeSub({ status: 'trial' }));
      repo.findOpenChargeByIntent.mockResolvedValue({
        id: 'charge-antiga',
        seats: 3,
        paymentKind: 'pix',
        pixPayload: '000201',
        pixExpiresAt: new Date(Date.now() + 3_600_000),
        asaasPaymentId: 'pay_antigo',
        metadata: { method: 'annual_pix' },
      } as never);

      await service.subscribeAnnualPix('company-1', { seats: 8 });

      expect(asaas.deletePayment).toHaveBeenCalledWith('pay_antigo');
      expect(repo.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({ seats: 8, amountCents: annualTotalCents(8) }),
      );
    });

    it('Pix aberto pela MESMA quantidade continua sendo reaproveitado (B2)', async () => {
      const { service, repo, asaas } = makeService(makeSub({ status: 'trial' }));
      repo.findOpenChargeByIntent.mockResolvedValue({
        id: 'charge-aberta',
        seats: 8,
        paymentKind: 'pix',
        pixPayload: '000201',
        pixExpiresAt: new Date(Date.now() + 3_600_000),
        asaasPaymentId: 'pay_aberto',
        metadata: { method: 'annual_pix' },
      } as never);

      await service.subscribeAnnualPix('company-1', { seats: 8 });

      expect(asaas.deletePayment).not.toHaveBeenCalled();
      expect(repo.createCharge).not.toHaveBeenCalled();
    });
  });

  /**
   * O botão "Já paguei": quem acabou de pagar não deve ficar olhando a tela até o
   * webhook chegar. O risco aqui é o oposto do óbvio — dizer "pago" quando não foi,
   * ou dizer "não identificado" só porque o cooldown do getStatus estava ativo.
   */
  describe('conferirPagamento', () => {
    it('confere no Asaas mesmo dentro do cooldown do getStatus (é clique explícito)', async () => {
      const { service, repo, webhook } = makeService(makeSub({ status: 'trial' }));
      repo.findPendingChargesByCompany.mockResolvedValue([
        { id: 'charge-1', asaasPaymentId: 'pay_1' },
      ] as never);

      // O getStatus arma o cooldown de 30s...
      await service.getStatus('company-1');
      webhook.reconcilePayment.mockClear();

      // ...e a conferência explícita tem de furar esse cooldown.
      await service.conferirPagamento('company-1');

      expect(webhook.reconcilePayment).toHaveBeenCalledWith('pay_1');
    });

    it('cobrança que virou paga → pago: true', async () => {
      const { service, repo } = makeService(makeSub({ status: 'trial' }));
      repo.findPendingChargesByCompany.mockResolvedValue([
        { id: 'charge-1', asaasPaymentId: 'pay_1' },
      ] as never);
      repo.findChargeById.mockResolvedValue({ id: 'charge-1', status: 'paid' } as never);

      const r = await service.conferirPagamento('company-1');

      expect(r.pago).toBe(true);
    });

    it('cobrança ainda pendente → pago: false (o aviso de "não identificado" é honesto)', async () => {
      const { service, repo } = makeService(makeSub({ status: 'trial' }));
      repo.findPendingChargesByCompany.mockResolvedValue([
        { id: 'charge-1', asaasPaymentId: 'pay_1' },
      ] as never);
      repo.findChargeById.mockResolvedValue({ id: 'charge-1', status: 'pending' } as never);

      const r = await service.conferirPagamento('company-1');

      expect(r.pago).toBe(false);
    });

    it('empresa JÁ ativa renovando antes de vencer não é dada como paga sem cobrança quitada', async () => {
      // Sem esta regra, "status === active" bastaria e a renovação antecipada
      // diria "pagamento confirmado" no primeiro clique, antes de qualquer Pix.
      const { service, repo } = makeService(
        makeSub({
          status: 'active',
          method: 'annual_pix',
          currentPeriodEnd: emDias(120),
        }),
      );
      repo.findPendingChargesByCompany.mockResolvedValue([
        { id: 'charge-1', asaasPaymentId: 'pay_1' },
      ] as never);
      repo.findChargeById.mockResolvedValue({ id: 'charge-1', status: 'pending' } as never);

      const r = await service.conferirPagamento('company-1');

      expect(r.pago).toBe(false);
    });

    it('mensal: também confere a recorrência, cuja cobrança nasce no Asaas', async () => {
      const { service, webhook } = makeService(
        makeSub({ status: 'past_due', method: 'monthly_card', asaasSubscriptionId: 'asub_1' }),
      );

      await service.conferirPagamento('company-1');

      expect(webhook.reconcileSubscription).toHaveBeenCalledWith('asub_1');
    });

    it('falha ao conferir a recorrência não derruba a resposta', async () => {
      const { service, webhook } = makeService(
        makeSub({ status: 'past_due', method: 'monthly_card', asaasSubscriptionId: 'asub_1' }),
      );
      webhook.reconcileSubscription.mockRejectedValue(new Error('Asaas fora'));

      await expect(service.conferirPagamento('company-1')).resolves.toMatchObject({ pago: false });
    });
  });

  /**
   * O par que faltava do "atualizar cartão": o cartão fica no Asaas e é trocado lá;
   * o endereço fica aqui e antes só era gravado de carona num pagamento.
   */
  describe('updateBillingAddress', () => {
    const ENDERECO = {
      name: 'Fulano de Tal',
      email: 'f@t.com',
      cpfCnpj: '123.456.789-09',
      postalCode: '01001-000',
      street: 'Praça da Sé',
      addressNumber: '10',
      neighborhood: 'Sé',
      city: 'São Paulo',
      state: 'sp',
      phone: '(11) 98765-4321',
    };

    it('grava sem máscara e sem tocar em cartão, plano ou cobrança', async () => {
      const { service, repo, asaas } = makeService(
        makeSub({ status: 'active', method: 'annual_pix' }),
      );

      await service.updateBillingAddress('company-1', ENDERECO);

      expect(repo.updateSubscription).toHaveBeenCalledWith('sub-uuid', {
        billingName: 'Fulano de Tal',
        billingEmail: 'f@t.com',
        billingCpfCnpj: '12345678909',
        billingPostalCode: '01001000',
        billingStreet: 'Praça da Sé',
        billingAddressNumber: '10',
        billingAddressComplement: null,
        billingNeighborhood: 'Sé',
        billingCity: 'São Paulo',
        // UF normalizada para maiúscula na borda.
        billingState: 'SP',
        billingPhone: '11987654321',
      });
      // Nada é cobrado: só o cadastro do cliente é sincronizado no provedor.
      expect(asaas.createCheckout).not.toHaveBeenCalled();
      expect(asaas.createPayment).not.toHaveBeenCalled();
      expect(repo.createCharge).not.toHaveBeenCalled();
    });

    it('corrige razão social e CNPJ e sincroniza o cliente no provedor', async () => {
      const { service, repo, asaas } = makeService(
        makeSub({ status: 'active', method: 'monthly_card', asaasCustomerId: 'cus_1' }),
      );
      repo.findCompanyByTaxIdExcluding.mockResolvedValue(null);

      await service.updateBillingAddress('company-1', {
        ...ENDERECO,
        legalName: 'Acme S.A.',
        taxId: '11.222.333/0001-81',
      });

      expect(repo.updateCompanyFiscal).toHaveBeenCalledWith('company-1', {
        legalName: 'Acme S.A.',
        taxId: '11222333000181',
      });
      // Sem isto as próximas cobranças sairiam com o documento antigo na nota.
      // O cadastro do cliente é o que a página do Asaas exibe: vai fiscal E endereço.
      expect(asaas.updateCustomer).toHaveBeenCalledWith(
        'cus_1',
        expect.objectContaining({
          name: 'Acme S.A.',
          cpfCnpj: '11222333000181',
          address: 'Praça da Sé',
          province: 'Sé',
          city: 'São Paulo',
        }),
      );
    });

    it('recusa CNPJ que já pertence a outra empresa', async () => {
      const { service, repo } = makeService(makeSub({ status: 'trial' }));
      repo.findCompanyByTaxIdExcluding.mockResolvedValue({ id: 'outra' } as never);

      await expect(
        service.updateBillingAddress('company-1', { ...ENDERECO, taxId: '11222333000181' }),
      ).rejects.toThrow(/Já existe uma empresa com este CNPJ/);
      expect(repo.updateCompanyFiscal).not.toHaveBeenCalled();
    });

    it('falha ao sincronizar com o provedor não desfaz a correção local', async () => {
      const { service, repo, asaas } = makeService(
        makeSub({ status: 'active', asaasCustomerId: 'cus_1' }),
      );
      repo.findCompanyByTaxIdExcluding.mockResolvedValue(null);
      asaas.updateCustomer.mockRejectedValue(new Error('Asaas fora'));

      await expect(
        service.updateBillingAddress('company-1', { ...ENDERECO, legalName: 'Acme S.A.' }),
      ).resolves.toBeDefined();
      expect(repo.updateCompanyFiscal).toHaveBeenCalled();
    });

    it('sem dados fiscais no corpo, não mexe na empresa', async () => {
      const { service, repo, asaas } = makeService(makeSub({ status: 'trial' }));

      await service.updateBillingAddress('company-1', ENDERECO);

      expect(repo.updateCompanyFiscal).not.toHaveBeenCalled();
      expect(asaas.updateCustomer).not.toHaveBeenCalled();
    });

    it('funciona no anual e no trial — não depende de ter cartão', async () => {
      for (const sub of [
        makeSub({ status: 'trial' }),
        makeSub({ status: 'active', method: 'annual_pix' }),
      ]) {
        const { service, repo } = makeService(sub);
        await service.updateBillingAddress('company-1', ENDERECO);
        expect(repo.updateSubscription).toHaveBeenCalled();
      }
    });
  });

  describe('getStatus', () => {
    it('concilia cobranças pendentes no Asaas antes de montar o status', async () => {
      const sub = makeSub({ status: 'active', method: 'annual_pix', purchasedSeats: 1 });
      const repo = makeRepo(sub);
      repo.findPendingChargesByCompany.mockResolvedValue([
        { id: 'charge-1', asaasPaymentId: 'pay_1' },
      ]);
      const webhook = makeWebhook();
      const asaasDoTeste = makeAsaas();
      const cfg = makeConfig();
      const service = new BillingService(
        repo,
        asaasDoTeste,
        cfg,
        webhook,
        new BillingCheckoutService(asaasDoTeste, repo, cfg, logger),
        makeMailer(),
        logger,
      );
      await service.getStatus('company-1');

      expect(webhook.reconcilePayment).toHaveBeenCalledWith('pay_1');
    });

    it('expõe o endereço de cobrança guardado (form de cartão vem preenchido)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        billingName: 'Fulano de Tal',
        billingEmail: 'f@t.com',
        billingCpfCnpj: '12345678909',
        billingPostalCode: '01001000',
        billingAddressNumber: '10',
        billingAddressComplement: null,
        billingPhone: '11987654321',
      });
      const repoLocal = makeRepo(sub);
      const asaasLocal = makeAsaas();
      const cfgLocal = makeConfig(true);
      const service = new BillingService(
        repoLocal,
        asaasLocal,
        cfgLocal,
        makeWebhook(),
        new BillingCheckoutService(asaasLocal, repoLocal, cfgLocal, logger),
        makeMailer(),
        logger,
      );

      const status = await service.getStatus('company-1');

      expect(status.billingAddress).toEqual({
        name: 'Fulano de Tal',
        email: 'f@t.com',
        cpfCnpj: '12345678909',
        postalCode: '01001000',
        street: 'Praça da Sé',
        addressNumber: '10',
        addressComplement: '',
        neighborhood: 'Sé',
        city: 'São Paulo',
        state: 'SP',
        phone: '11987654321',
      });
      expect(status.profileComplete).toBe(true);
    });

    it('expõe os componentes do preço e o teto de assentos (a tela abre a conta sem recalcular)', async () => {
      const { service } = makeService(makeSub({ status: 'trial' }));

      const status = await service.getStatus('company-1');

      expect(status.prices).toEqual({
        monthlyCents: MONTHLY_BASE_CENTS,
        annualCents: annualTotalCents(1),
        baseCents: MONTHLY_BASE_CENTS,
        extraSeatCents: MONTHLY_EXTRA_SEAT_CENTS,
        annualSeatCents: ANNUAL_SEAT_CENTS,
        maxSeats: MAX_SEATS,
        annualDiscountPercent: 25,
      });
    });

    it('devolve o cadastro nulo enquanto ninguém preencheu os dados de cobrança', async () => {
      const { service } = makeService(makeSub({ status: 'trial', billingCpfCnpj: null }));

      const status = await service.getStatus('company-1');

      expect(status.billingAddress).toBeNull();
      expect(status.profileComplete).toBe(false);
    });
  });
});
