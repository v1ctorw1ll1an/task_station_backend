import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';
import { AsaasClient } from './asaas/asaas.client';
import { BillingAccessService } from './billing-access.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';
import { GRACE_DAYS, TRIAL_DAYS } from './billing.constants';

/**
 * Trava de regra de negócio (docs/cobranca-regras.md). Este spec não testa
 * implementação: ele fixa **o que o cliente paga e o que ele recebe**. Se uma
 * refatoração quebrar algo aqui, ou a regra mudou de propósito (atualize o doc E o
 * teste) ou a mudança está errada.
 */

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

/** Perfil de cobrança completo — pré-requisito de qualquer pagamento. */
const PERFIL = {
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

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    companyId: 'c1',
    status: 'trial',
    method: null,
    purchasedSeats: 1,
    addonSeats: 0,
    seatsAtNextRenewal: null,
    asaasCustomerId: 'cus_1',
    asaasSubscriptionId: null,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    superadminLocked: false,
    ...PERFIL,
    ...overrides,
  };
}

function makeRepo(sub: Record<string, unknown>) {
  return {
    findSubscriptionByCompany: jest.fn().mockResolvedValue(sub),
    findSubscriptionById: jest.fn().mockResolvedValue(sub),
    findSubscriptionByAsaasSubscriptionId: jest.fn().mockResolvedValue(sub),
    updateSubscription: jest.fn().mockResolvedValue(sub),
    countOccupiedSeats: jest.fn().mockResolvedValue(1),
    findCompanySeatHolders: jest
      .fn()
      .mockResolvedValue([{ userId: 'dono', role: 'admin', scheduledRemovalAt: null }]),
    scheduleSeatRemovals: jest.fn().mockResolvedValue(undefined),
    applyScheduledSeatRemovals: jest.fn().mockResolvedValue({ count: 0 }),
    getCompanyFiscal: jest
      .fn()
      .mockResolvedValue({ legalName: 'ACME', taxId: '11222333000181', adminEmail: 'a@b.com' }),
    createCharge: jest.fn().mockResolvedValue({ id: 'chg_1', companyId: 'c1', amountCents: 0 }),
    updateCharge: jest.fn().mockResolvedValue({ id: 'chg_1' }),
    findCharges: jest.fn().mockResolvedValue([[], 0]),
    findPendingPixCharge: jest.fn().mockResolvedValue(null),
    findLatestPendingCharge: jest.fn().mockResolvedValue(null),
    findPendingChargesByCompany: jest.fn().mockResolvedValue([]),
    findOpenChargeByIntent: jest.fn().mockResolvedValue(null),
    findChargeById: jest.fn().mockResolvedValue(null),
    findChargeByAsaasPaymentId: jest.fn().mockResolvedValue(null),
    findChargeByCheckoutId: jest.fn().mockResolvedValue(null),
    markChargePaid: jest.fn().mockResolvedValue({ count: 1 }),
    findCompanyAdminEmails: jest.fn().mockResolvedValue(['admin@co.com']),
    createWebhookEvent: jest.fn().mockResolvedValue({ id: 'evt_row' }),
    markWebhookProcessed: jest.fn().mockResolvedValue({}),
    scheduleWebhookRetry: jest.fn().mockResolvedValue({}),
    markWebhookDead: jest.fn().mockResolvedValue({}),
    createSeatAddon: jest.fn().mockResolvedValue({ id: 'addon_1', seats: 1 }),
    updateSeatAddon: jest.fn().mockResolvedValue({ id: 'addon_1' }),
    findSeatAddonById: jest.fn().mockResolvedValue(null),
    findSeatAddonByAsaasSubscription: jest.fn().mockResolvedValue(null),
    findSeatAddons: jest.fn().mockResolvedValue([]),
    sumActiveAddonSeats: jest.fn().mockResolvedValue(0),
    syncAddonSeats: jest.fn().mockResolvedValue(0),
    withCompanyLock: jest.fn().mockImplementation((_c: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as jest.Mocked<BillingRepository>;
}

function makeAsaas(payment: Record<string, unknown> = {}) {
  return {
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_1' }),
    updateCustomer: jest.fn().mockResolvedValue({ id: 'cus_1' }),
    createCheckout: jest
      .fn()
      .mockResolvedValue({ id: 'chk_1', link: 'https://asaas/chk_1', status: 'ACTIVE' }),
    cancelCheckout: jest.fn().mockResolvedValue({ id: 'chk_1', status: 'CANCELED' }),
    createSubscription: jest.fn().mockResolvedValue({ id: 'asub_1', status: 'ACTIVE' }),
    deleteSubscription: jest.fn().mockResolvedValue({ deleted: true }),
    deletePayment: jest.fn().mockResolvedValue({ deleted: true }),
    updateSubscriptionValue: jest.fn().mockResolvedValue({}),
    listCustomerSubscriptions: jest.fn().mockResolvedValue({ data: [] }),
    listSubscriptionPayments: jest.fn().mockResolvedValue({ data: [] }),
    listPayments: jest.fn().mockResolvedValue({ data: [] }),
    createPayment: jest.fn().mockResolvedValue({ id: 'pay_1', invoiceUrl: 'http://inv' }),
    getPayment: jest.fn().mockResolvedValue(payment),
    getPixQrCode: jest.fn().mockResolvedValue({
      encodedImage: 'img',
      payload: '000201',
      expirationDate: '2026-12-31 23:59:59',
    }),
  } as unknown as jest.Mocked<AsaasClient>;
}

const config = {
  get: (k: string, d?: string) =>
    ({
      BILLING_ENABLED: 'true',
      BILLING_ANNUAL_INTEREST_MONTHLY: '0',
      FRONTEND_URL: 'https://app.taskdy.test',
    })[k] ?? d,
} as unknown as ConfigService;

function makeBilling(sub: Record<string, unknown>) {
  const repo = makeRepo(sub);
  const asaas = makeAsaas();
  const webhook = { reconcilePayment: jest.fn() } as unknown as jest.Mocked<BillingWebhookService>;
  const mailer = {
    sendSeatPixEmail: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailerService>;
  const checkout = new BillingCheckoutService(asaas, repo, config, logger);
  const service = new BillingService(repo, asaas, config, webhook, checkout, mailer, logger);
  return { service, repo, asaas, checkout };
}

function makeWebhook(sub: Record<string, unknown>, payment: Record<string, unknown>) {
  const repo = makeRepo(sub);
  const asaas = makeAsaas(payment);
  const access = { invalidate: jest.fn() } as unknown as jest.Mocked<BillingAccessService>;
  const mailer = {
    sendPaymentConfirmedEmail: jest.fn().mockResolvedValue(undefined),
    sendPaymentFailedEmail: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailerService>;
  const alerts = {
    raise: jest.fn().mockResolvedValue(undefined),
  } as unknown as BillingAlertsService;
  const metrics = {
    billingWebhook: jest.fn(),
    billingReconcile: jest.fn(),
  } as unknown as MetricsService;
  const checkout = new BillingCheckoutService(asaas, repo, config, logger);
  const service = new BillingWebhookService(
    repo,
    asaas,
    access,
    checkout,
    mailer,
    alerts,
    metrics,
    logger,
  );
  return { service, repo, asaas, access };
}

describe('Regras de cobrança (trava de regressão)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('R4/R22 — prazos', () => {
    it('trial de 7 dias e carência de 3 dias', () => {
      expect(TRIAL_DAYS).toBe(7);
      expect(GRACE_DAYS).toBe(3);
    });

    it('carência começa no vencimento + 3 dias (R22)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        asaasSubscriptionId: 'asub_1',
      });
      const { service, repo } = makeWebhook(sub, {
        id: 'pay_1',
        status: 'OVERDUE',
        subscription: 'asub_1',
        dueDate: '2026-07-20',
      });

      await service.handle({
        id: 'e1',
        event: 'PAYMENT_OVERDUE',
        payment: { id: 'pay_1' } as never,
      });

      const data = repo.updateSubscription.mock.calls[0][1] as { graceUntil: Date };
      expect(data.graceUntil.toISOString()).toBe(
        new Date('2026-07-23T00:00:00-03:00').toISOString(),
      );
    });
  });

  // ── O coração da mudança: valor cheio, sem proração ────────────────────────

  describe('assento custa valor cheio, sempre', () => {
    it('mensal: o dia do mês não muda o preço', async () => {
      // Dois cenários idênticos, menos a data: mesma cobrança.
      for (const dia of ['2026-07-11T00:00:00Z', '2026-08-09T00:00:00Z']) {
        jest.clearAllMocks();
        const sub = makeSub({
          status: 'active',
          method: 'monthly_card',
          asaasSubscriptionId: 'asub_1',
          currentPeriodStart: new Date(dia),
          currentPeriodEnd: new Date('2026-08-10T00:00:00Z'),
        });
        const { service, repo } = makeBilling(sub);

        await service.buySeats('c1', { quantity: 2 });

        expect(repo.createCharge).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'seat', amountCents: 3980, seatsDelta: 2 }),
        );
      }
    });

    it('anual: um ano cheio por assento, numa assinatura própria', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'annual_pix',
        currentPeriodEnd: new Date('2027-07-10T00:00:00Z'),
      });
      const { service, repo, asaas } = makeBilling(sub);

      await service.buySeats('c1', { quantity: 1, paymentKind: 'pix' });

      expect(repo.createSeatAddon).toHaveBeenCalledWith(
        expect.objectContaining({ seats: 1, unitPriceCents: 17910, amountCents: 17910 }),
      );
      // A assinatura é NOVA e anual — a data de renovação dela é a da compra.
      expect(asaas.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ cycle: 'YEARLY', value: 179.1 }),
      );
    });

    it('o assento só vale DEPOIS de pago (nunca na criação da cobrança)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        asaasSubscriptionId: 'asub_1',
        currentPeriodEnd: new Date('2026-08-10T00:00:00Z'),
      });
      const { service, repo } = makeBilling(sub);

      await service.buySeats('c1', { quantity: 1 });

      for (const [, data] of repo.updateSubscription.mock.calls) {
        expect(data).not.toHaveProperty('purchasedSeats');
      }
    });

    it('pago o assento mensal, a mensalidade sobe só das PRÓXIMAS cobranças', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        purchasedSeats: 2,
        asaasSubscriptionId: 'asub_1',
      });
      const { service, repo, asaas } = makeWebhook(sub, {
        id: 'pay_1',
        status: 'RECEIVED',
        value: 19.9,
      });
      repo.findChargeByAsaasPaymentId.mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'seat',
        seatsDelta: 1,
        seatAddonId: null,
        amountCents: 1990,
      } as never);

      await service.handle({
        id: 'e1',
        event: 'PAYMENT_RECEIVED',
        payment: { id: 'pay_1' } as never,
      });

      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', {
        purchasedSeats: { increment: 1 },
      });
      // 3 assentos = 49,90 + 2×19,90 = 89,70
      expect(asaas.updateSubscriptionValue).toHaveBeenCalledWith('asub_1', 89.7);
    });
  });

  describe('reduzir só existe no mensal', () => {
    it('mensal: agenda para a renovação, sem mexer no total de hoje', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        purchasedSeats: 3,
        asaasSubscriptionId: 'asub_1',
      });
      const { service, repo } = makeBilling(sub);
      repo.countOccupiedSeats.mockResolvedValue(1);

      await service.reduceSeats('c1', { quantity: 1 });

      const data = repo.updateSubscription.mock.calls[0][1] as Record<string, unknown>;
      expect(data).toEqual({ seatsAtNextRenewal: 2 });
      expect(data).not.toHaveProperty('purchasedSeats');
    });

    it('anual: a operação não existe', async () => {
      for (const method of ['annual_pix', 'annual_card']) {
        const sub = makeSub({ status: 'active', method, purchasedSeats: 3 });
        const { service } = makeBilling(sub);
        await expect(service.reduceSeats('c1', { quantity: 1 })).rejects.toThrow(/plano mensal/);
      }
    });

    it('a redução agendada é aplicada na renovação paga (R19)', async () => {
      const sub = makeSub({
        status: 'past_due',
        method: 'monthly_card',
        purchasedSeats: 3,
        seatsAtNextRenewal: 2,
      });
      const { service, repo } = makeWebhook(sub, { id: 'pay_1', status: 'RECEIVED', value: 59.8 });
      repo.findChargeByAsaasPaymentId.mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'renewal',
        amountCents: 5980,
      } as never);

      await service.handle({
        id: 'e1',
        event: 'PAYMENT_RECEIVED',
        payment: { id: 'pay_1' } as never,
      });

      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ purchasedSeats: 2, seatsAtNextRenewal: null }),
      );
    });

    it('a empresa nunca fica sem assento (mínimo 1 — R11)', async () => {
      const sub = makeSub({ status: 'active', method: 'monthly_card', purchasedSeats: 1 });
      const { service, repo } = makeBilling(sub);
      repo.countOccupiedSeats.mockResolvedValue(0);
      await expect(service.reduceSeats('c1', { quantity: 1 })).rejects.toThrow(/ao menos 1/);
    });
  });

  describe('assentos e direito de uso', () => {
    it('a cobrança segue os assentos CONTRATADOS, não os ocupados', async () => {
      const sub = makeSub({ status: 'active', method: 'monthly_card', purchasedSeats: 3 });
      const { service, repo } = makeBilling(sub);
      repo.countOccupiedSeats.mockResolvedValue(1);

      const status = await service.getStatus('c1');

      expect(status.purchasedSeats).toBe(3);
      expect(status.occupiedSeats).toBe(1);
      expect(status.availableSeats).toBe(2);
      // 3 assentos = 49,90 + 2×19,90 = 89,70 (independe de quantos estão ocupados)
      expect(status.prices.monthlyCents).toBe(8970);
    });

    it('assentos avulsos do anual contam no direito de uso', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'annual_pix',
        purchasedSeats: 2,
        addonSeats: 3,
      });
      const { service, repo } = makeBilling(sub);
      repo.countOccupiedSeats.mockResolvedValue(4);

      const status = await service.getStatus('c1');

      expect(status.purchasedSeats).toBe(5); // 2 do plano + 3 avulsos
      expect(status.planSeats).toBe(2);
      expect(status.addonSeats).toBe(3);
      expect(status.availableSeats).toBe(1);
    });

    it('o gate de assentos usa o total (plano + avulsos)', async () => {
      const sub = makeSub({ status: 'active', purchasedSeats: 2, addonSeats: 3 });
      const { service, repo } = makeBilling(sub);

      repo.countOccupiedSeats.mockResolvedValue(4);
      await expect(service.assertSeatAvailable('c1')).resolves.toBeUndefined();

      repo.countOccupiedSeats.mockResolvedValue(5);
      await expect(service.assertSeatAvailable('c1')).rejects.toMatchObject({
        response: { code: 'SEAT_LIMIT' },
      });
    });
  });

  describe('R24 — pagamento confirmado reativa na hora', () => {
    it('ativa a assinatura e invalida o cache do gate', async () => {
      const sub = makeSub({ status: 'readonly', method: 'annual_pix' });
      const { service, repo, access } = makeWebhook(sub, {
        id: 'pay_1',
        status: 'RECEIVED',
        value: 449.1,
      });
      repo.findChargeByAsaasPaymentId.mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'subscription',
        amountCents: 44910,
      } as never);

      await service.handle({
        id: 'e1',
        event: 'PAYMENT_RECEIVED',
        payment: { id: 'pay_1' } as never,
      });

      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ status: 'active', graceUntil: null }),
      );
      expect(access.invalidate).toHaveBeenCalledWith('c1');
    });
  });

  // ── Zero cartão: agora vale para o código inteiro, não só para o que é gravado ──

  describe('nenhum dado de cartão entra no sistema', () => {
    it('o schema não tem coluna de cartão', () => {
      const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
      for (const forbidden of [
        'asaasCardToken',
        'asaas_card_token',
        'cardBrand',
        'card_brand',
        'cardLastFour',
        'card_last_four',
        'creditCardToken',
      ]) {
        expect(schema).not.toContain(forbidden);
      }
    });

    /**
     * A trava mais forte da mudança: com o checkout hospedado, o PAN não chega nem à
     * borda da API. Se alguém reintroduzir um campo de cartão num DTO "para melhorar a
     * UX", este teste quebra antes de o código chegar em produção.
     */
    it('nenhum DTO de cobrança aceita campo de cartão', () => {
      const dir = join(__dirname, 'dto');
      for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        const fonte = readFileSync(join(dir, arquivo), 'utf8');
        // Ignora linhas de comentário: a proibição é sobre campo declarado, e explicar
        // por que ele não existe é justamente o que queremos manter escrito.
        const codigo = fonte
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');
        expect(codigo).not.toMatch(/creditCard|holderName|\bccv\b|expiryMonth|expiryYear/i);
      }
    });

    it('o cliente Asaas não expõe mais tokenização nem pagamento com cartão', () => {
      const client = readFileSync(join(__dirname, 'asaas/asaas.client.ts'), 'utf8');
      expect(client).not.toContain('tokenizeCreditCard');
      expect(client).not.toContain('payWithCreditCard');
    });

    it('assinar no mensal só devolve o link do checkout — nada de cartão trafega', async () => {
      const { service, repo } = makeBilling(makeSub());
      const r = await service.subscribeMonthly('c1', {});

      expect(r.checkoutUrl).toBe('https://asaas/chk_1');
      const dump = JSON.stringify([
        ...repo.createCharge.mock.calls.map((c) => c[0]),
        ...repo.updateCharge.mock.calls.map((c) => c[1]),
        ...repo.updateSubscription.mock.calls.map((c) => c[1]),
      ]);
      expect(dump).not.toMatch(/creditCard|ccv|holderName/i);
    });
  });

  describe('dados de cobrança são pré-requisito do pagamento', () => {
    it('sem perfil completo, o checkout nem abre', async () => {
      const { service } = makeBilling(makeSub({ billingStreet: null }));
      await expect(service.subscribeMonthly('c1', {})).rejects.toMatchObject({
        response: { code: 'BILLING_PROFILE_INCOMPLETE' },
      });
    });

    it('o perfil é empurrado para o cadastro do cliente no Asaas', async () => {
      const { service, asaas } = makeBilling(makeSub());
      await service.subscribeMonthly('c1', {});

      expect(asaas.updateCustomer).toHaveBeenCalledWith(
        'cus_1',
        expect.objectContaining({
          address: 'Praça da Sé',
          province: 'Sé',
          city: 'São Paulo',
          postalCode: '01001000',
        }),
      );
    });
  });

  describe('uma cobrança aberta por vez', () => {
    it('checkout ainda válido é reaproveitado, não recriado', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        asaasSubscriptionId: 'asub_1',
        currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
      });
      const { service, repo, asaas } = makeBilling(sub);
      repo.createCharge.mockResolvedValue({
        id: 'chg_1',
        companyId: 'c1',
        amountCents: 1990,
        checkoutUrl: 'https://asaas/antigo',
        checkoutExpiresAt: new Date(Date.now() + 3_600_000),
      } as never);

      const r = await service.buySeats('c1', { quantity: 1 });

      expect(r.checkoutUrl).toBe('https://asaas/antigo');
      expect(asaas.createCheckout).not.toHaveBeenCalled();
    });

    it('compra de assentos em aberto bloqueia outra', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'monthly_card',
        currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
      });
      const { service, repo } = makeBilling(sub);
      repo.findOpenChargeByIntent.mockResolvedValue({ id: 'chg_aberta' } as never);

      await expect(service.buySeats('c1', { quantity: 1 })).rejects.toThrow(/aguardando pagamento/);
    });
  });

  describe('R25/R26 — cancelamento', () => {
    it('cancelar mantém o acesso até o fim do ciclo pago (não vira readonly na hora)', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'annual_pix',
        currentPeriodEnd: new Date('2027-01-10T00:00:00Z'),
      });
      const { service, repo } = makeBilling(sub);

      await service.cancel('c1');

      const data = repo.updateSubscription.mock.calls[0][1] as Record<string, unknown>;
      expect(data.cancelAtPeriodEnd).toBe(true);
      expect(data).not.toHaveProperty('status');
    });

    /**
     * As assinaturas de assentos anuais têm vida própria no Asaas. Sem esta cascata, o
     * cliente cancelaria o plano e continuaria sendo cobrado por elas todo ano — o modo
     * de falha mais caro que a mudança introduziu.
     */
    it('cancelar o plano encerra as assinaturas de assentos anuais', async () => {
      const sub = makeSub({
        status: 'active',
        method: 'annual_pix',
        addonSeats: 2,
        currentPeriodEnd: new Date('2027-01-10T00:00:00Z'),
      });
      const { service, repo, asaas } = makeBilling(sub);
      repo.findSeatAddons.mockResolvedValue([
        { id: 'addon_1', seats: 2, asaasSubscriptionId: 'asub_addon', subscriptionId: 'sub_1' },
      ] as never);

      await service.cancel('c1');

      expect(asaas.deleteSubscription).toHaveBeenCalledWith('asub_addon');
      expect(repo.updateSeatAddon).toHaveBeenCalledWith(
        'addon_1',
        expect.objectContaining({ status: 'canceled' }),
      );
    });
  });
});
