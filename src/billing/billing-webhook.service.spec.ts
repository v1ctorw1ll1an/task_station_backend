import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';
import { AsaasClient } from './asaas/asaas.client';
import { BillingAccessService } from './billing-access.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingRepository } from './billing.repository';
import { BillingWebhookService } from './billing-webhook.service';

function makeRepo(
  overrides: Partial<jest.Mocked<BillingRepository>> = {},
): jest.Mocked<BillingRepository> {
  return {
    createWebhookEvent: jest.fn().mockResolvedValue({ id: 'evt-row' }),
    markWebhookProcessed: jest.fn().mockResolvedValue({}),
    scheduleWebhookRetry: jest.fn().mockResolvedValue({}),
    markWebhookDead: jest.fn().mockResolvedValue({}),
    findChargeByAsaasPaymentId: jest.fn().mockResolvedValue(null),
    findChargeById: jest.fn().mockResolvedValue(null),
    findOpenChargeByIntent: jest.fn().mockResolvedValue(null),
    findSubscriptionByCompany: jest.fn().mockResolvedValue(null),
    findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(null),
    markChargePaid: jest.fn().mockResolvedValue({ count: 1 }),
    findSubscriptionById: jest.fn(),
    findSubscriptionByAsaasSubscriptionId: jest.fn(),
    createCharge: jest.fn(),
    updateCharge: jest.fn().mockImplementation((id: string, data: object) => ({ id, ...data })),
    updateSubscription: jest.fn().mockResolvedValue({}),
    findCompanyAdminEmails: jest.fn().mockResolvedValue(['admin@co.com']),
    findSubscriptionByAsaasCustomerId: jest.fn().mockResolvedValue(null),
    findChargeByCheckoutId: jest.fn().mockResolvedValue(null),
    findSeatAddonById: jest.fn().mockResolvedValue(null),
    findSeatAddonByAsaasSubscription: jest.fn().mockResolvedValue(null),
    updateSeatAddon: jest.fn().mockResolvedValue({}),
    syncAddonSeats: jest.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as jest.Mocked<BillingRepository>;
}

function makeAsaas(payment: unknown, extra: Partial<AsaasClient> = {}): jest.Mocked<AsaasClient> {
  return {
    getPayment: jest.fn().mockResolvedValue(payment),
    updateSubscriptionValue: jest.fn().mockResolvedValue({}),
    listSubscriptionPayments: jest.fn().mockResolvedValue({ data: [] }),
    ...extra,
  } as unknown as jest.Mocked<AsaasClient>;
}

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;
const access = { invalidate: jest.fn(), isBlocked: jest.fn() } as unknown as BillingAccessService;
const mailer = {
  sendPaymentConfirmedEmail: jest.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: jest.fn().mockResolvedValue(undefined),
} as unknown as jest.Mocked<MailerService>;
const alerts = {
  raise: jest.fn().mockResolvedValue(undefined),
} as unknown as jest.Mocked<BillingAlertsService>;
const metrics = {
  billingWebhook: jest.fn(),
  billingReconcile: jest.fn(),
  billingAlert: jest.fn(),
  billingLastWebhookAge: jest.fn(),
} as unknown as jest.Mocked<MetricsService>;

/**
 * Checkout dublê: o webhook só o consulta quando precisa DESCOBRIR uma assinatura ou
 * um pagamento que o Asaas criou por fora. Devolver `null` por padrão mantém os testes
 * de pagamento comum no caminho antigo (o `externalReference` resolve tudo).
 */
const checkout = {
  abrir: jest.fn(),
  cancelar: jest.fn().mockResolvedValue(undefined),
  resolverAssinatura: jest.fn().mockResolvedValue(null),
  casarPagamento: jest.fn().mockResolvedValue(null),
} as unknown as jest.Mocked<BillingCheckoutService>;

function makeService(repo: BillingRepository, asaas: AsaasClient): BillingWebhookService {
  return new BillingWebhookService(repo, asaas, access, checkout, mailer, alerts, metrics, logger);
}

const CHARGE_UUID = '11111111-2222-3333-4444-555555555555';

describe('BillingWebhookService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ativa a assinatura quando um pagamento de cobrança nossa é confirmado', async () => {
    const fresh = { id: 'pay_1', status: 'CONFIRMED', value: 39.9 };
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'subscription',
      }),
      findSubscriptionById: jest.fn().mockResolvedValue({
        id: 'sub_1',
        method: 'annual_pix',
        superadminLocked: false,
        currentPeriodStart: null,
      }),
    });
    const service = makeService(repo, makeAsaas(fresh));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.markChargePaid).toHaveBeenCalledWith('chg_1');
    expect(repo.updateSubscription).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ status: 'active', graceUntil: null }),
    );
    expect(repo.markWebhookProcessed).toHaveBeenCalledWith('evt-row', 'processed');
  });

  it('envia e-mail de pagamento confirmado ao ativar (R24)', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'subscription',
        amountCents: 43092,
      }),
      findSubscriptionById: jest.fn().mockResolvedValue({
        id: 'sub_1',
        method: 'annual_pix',
        superadminLocked: false,
      }),
    });
    const service = makeService(
      repo,
      makeAsaas({ id: 'pay_1', status: 'RECEIVED', value: 430.92 }),
    );

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1' } as never,
    });

    expect(mailer.sendPaymentConfirmedEmail).toHaveBeenCalledWith(
      ['admin@co.com'],
      'c1',
      expect.any(String),
    );
  });

  it('é idempotente: evento duplicado (unique) vira no-op', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    const repo = makeRepo({ createWebhookEvent: jest.fn().mockRejectedValue(p2002) });
    const asaas = makeAsaas({ id: 'pay_1', status: 'CONFIRMED' });
    const service = makeService(repo, asaas);

    await expect(
      service.handle({
        id: 'evt_1',
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_1' } as never,
      }),
    ).resolves.toBe('duplicate');

    expect(asaas.getPayment).not.toHaveBeenCalled();
    expect(repo.markChargePaid).not.toHaveBeenCalled();
  });

  // ── B1: inbox durável ──────────────────────────────────────────────────────

  it('não confirma o evento quando não consegue gravá-lo (B1)', async () => {
    const repo = makeRepo({
      createWebhookEvent: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const asaas = makeAsaas({ id: 'pay_1', status: 'CONFIRMED' });
    const service = makeService(repo, asaas);

    await expect(
      service.handle({
        id: 'evt_1',
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_1' } as never,
      }),
    ).resolves.toBe('persist_failed');

    expect(asaas.getPayment).not.toHaveBeenCalled();
  });

  it('grava o evento com prazo de retomada (evento preso é recuperável)', async () => {
    const repo = makeRepo();
    const service = makeService(repo, makeAsaas({ id: 'pay_1', status: 'PENDING' }));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_CONFIRMED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.createWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'received', attempts: 0, nextAttemptAt: expect.any(Date) }),
    );
  });

  it('falha de processamento agenda reprocesso em vez de dar o evento por encerrado', async () => {
    const repo = makeRepo();
    const asaas = makeAsaas(null, {
      getPayment: jest.fn().mockRejectedValue(new Error('asaas down')),
    } as unknown as Partial<AsaasClient>);
    const service = makeService(repo, asaas);

    await expect(
      service.handle({
        id: 'evt_1',
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_1' } as never,
      }),
    ).resolves.toBe('ok');

    expect(repo.markWebhookProcessed).not.toHaveBeenCalled();
    expect(repo.scheduleWebhookRetry).toHaveBeenCalledWith(
      'evt-row',
      1,
      expect.any(Date),
      'asaas down',
    );
  });

  it('esgotadas as tentativas o evento vira dead e alerta', async () => {
    const repo = makeRepo();
    const asaas = makeAsaas(null, {
      getPayment: jest.fn().mockRejectedValue(new Error('asaas down')),
    } as unknown as Partial<AsaasClient>);
    const service = makeService(repo, asaas);

    await service.reprocess({
      id: 'evt-row',
      type: 'PAYMENT_CONFIRMED',
      payload: { id: 'evt_1', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } },
      attempts: 6,
    });

    expect(repo.markWebhookDead).toHaveBeenCalledWith('evt-row', 7, 'asaas down');
    expect(alerts.raise).toHaveBeenCalledWith(
      'webhook_dead',
      expect.objectContaining({ attempts: 7 }),
    );
  });

  // ── B4: cadeia de resolução ────────────────────────────────────────────────

  it('religa o pagamento à cobrança pelo externalReference quando o id não foi gravado', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue(null),
      findChargeById: jest.fn().mockResolvedValue({
        id: CHARGE_UUID,
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'subscription',
        asaasPaymentId: null,
        invoiceUrl: null,
      }),
      findSubscriptionById: jest
        .fn()
        .mockResolvedValue({ id: 'sub_1', method: 'annual_pix', superadminLocked: false }),
    });
    const fresh = {
      id: 'pay_1',
      status: 'RECEIVED',
      value: 430.92,
      externalReference: CHARGE_UUID,
    };
    const service = makeService(repo, makeAsaas(fresh));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.updateCharge).toHaveBeenCalledWith(
      CHARGE_UUID,
      expect.objectContaining({ asaasPaymentId: 'pay_1' }),
    );
    expect(repo.markChargePaid).toHaveBeenCalledWith(CHARGE_UUID);
  });

  it('alerta quando o pagamento confirmado não casa com nenhuma cobrança', async () => {
    const repo = makeRepo();
    const service = makeService(repo, makeAsaas({ id: 'pay_x', status: 'RECEIVED', value: 10 }));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_x' } as never,
    });

    expect(alerts.raise).toHaveBeenCalledWith(
      'payment_unmatched',
      expect.objectContaining({ paymentId: 'pay_x' }),
    );
    expect(repo.markChargePaid).not.toHaveBeenCalled();
  });

  it('re-busca o payment e ignora quando o status real diverge do evento', async () => {
    const repo = makeRepo();
    const asaas = makeAsaas({ id: 'pay_1', status: 'PENDING' }); // ainda não pago
    const service = makeService(repo, asaas);

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_CONFIRMED',
      payment: { id: 'pay_1' } as never,
    });

    expect(asaas.getPayment).toHaveBeenCalledWith('pay_1');
    expect(repo.markChargePaid).not.toHaveBeenCalled();
    expect(repo.markWebhookProcessed).toHaveBeenCalledWith('evt-row', 'ignored');
  });

  it('não reativa assinatura travada pelo superadmin', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'subscription',
      }),
      findSubscriptionById: jest.fn().mockResolvedValue({ id: 'sub_1', superadminLocked: true }),
    });
    const service = makeService(repo, makeAsaas({ id: 'pay_1', status: 'RECEIVED' }));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.updateSubscription).not.toHaveBeenCalled();
  });

  it('cobrança já paga (count 0) não reativa de novo', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'subscription',
      }),
      markChargePaid: jest.fn().mockResolvedValue({ count: 0 }),
    });
    const service = makeService(repo, makeAsaas({ id: 'pay_1', status: 'CONFIRMED' }));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_CONFIRMED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.findSubscriptionById).not.toHaveBeenCalled();
    expect(repo.updateSubscription).not.toHaveBeenCalled();
  });

  // ── B6: assento só vale (e só encarece) depois de pago ─────────────────────

  it('assento pago incrementa o total e só então sobe o valor recorrente', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue({
        id: 'chg_seat',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'seat',
        seatAddonId: null,
        seatsDelta: 2,
        amountCents: 3980,
      }),
      findSubscriptionById: jest.fn().mockResolvedValue({
        id: 'sub_1',
        method: 'monthly_card',
        asaasSubscriptionId: 'asub_1',
        purchasedSeats: 3,
        superadminLocked: false,
      }),
    });
    const asaas = makeAsaas({ id: 'pay_1', status: 'CONFIRMED', value: 10 });
    const service = makeService(repo, asaas);

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_CONFIRMED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', {
      purchasedSeats: { increment: 2 },
    });
    // 5 assentos = 49,90 + 4×19,90 = 129,50
    expect(asaas.updateSubscriptionValue).toHaveBeenCalledWith('asub_1', 129.5);
  });

  // ── B8: estorno alerta e não corta acesso ─────────────────────────────────

  it('estorno marca a cobrança, alerta e mantém o acesso', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest
        .fn()
        .mockResolvedValue({ id: 'chg_1', companyId: 'c1', type: 'subscription' }),
    });
    const service = makeService(repo, makeAsaas({ id: 'pay_1', status: 'REFUNDED', value: 39.9 }));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_REFUNDED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.updateCharge).toHaveBeenCalledWith('chg_1', { status: 'refunded' });
    expect(alerts.raise).toHaveBeenCalledWith(
      'payment_reversed',
      expect.objectContaining({ chargeId: 'chg_1' }),
    );
    expect(repo.updateSubscription).not.toHaveBeenCalled();
  });

  it('PAYMENT_OVERDUE coloca a assinatura mensal ativa em carência', async () => {
    const repo = makeRepo({
      findSubscriptionByAsaasSubscriptionId: jest.fn().mockResolvedValue({
        id: 'sub_1',
        companyId: 'c1',
        status: 'active',
        method: 'monthly_card',
      }),
    });
    const fresh = { id: 'pay_1', status: 'OVERDUE', subscription: 'asub_1', dueDate: '2026-07-20' };
    const service = makeService(repo, makeAsaas(fresh));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_OVERDUE',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.updateSubscription).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ status: 'past_due' }),
    );
    // R22: avisa a falha + prazo de carência por e-mail.
    expect(mailer.sendPaymentFailedEmail).toHaveBeenCalledWith(
      ['admin@co.com'],
      'c1',
      expect.any(Date),
      undefined,
    );
  });

  it('cria a cobrança para o pagamento gerado pela assinatura mensal nativa', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue(null),
      findSubscriptionByAsaasSubscriptionId: jest.fn().mockResolvedValue({
        id: 'sub_1',
        companyId: 'c1',
        purchasedSeats: 2,
        addonSeats: 0,
        currentPeriodStart: null,
        method: 'monthly_card',
        superadminLocked: false,
      }),
      createCharge: jest.fn().mockResolvedValue({
        id: 'chg_new',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'subscription',
      }),
      findSubscriptionById: jest
        .fn()
        .mockResolvedValue({ id: 'sub_1', method: 'monthly_card', superadminLocked: false }),
    });
    const fresh = { id: 'pay_1', status: 'CONFIRMED', value: 59.8, subscription: 'asub_1' };
    const service = makeService(repo, makeAsaas(fresh));

    await service.handle({
      id: 'evt_1',
      event: 'PAYMENT_CONFIRMED',
      payment: { id: 'pay_1' } as never,
    });

    expect(repo.createCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_1',
        type: 'subscription',
        amountCents: 5980,
        asaasPaymentId: 'pay_1',
        // C5: sem o método, o checkout trataria esta cobrança como de outro plano
        // e a cancelaria no Asaas.
        metadata: { method: 'monthly_card' },
      }),
    );
    expect(repo.markChargePaid).toHaveBeenCalledWith('chg_new');
  });

  // ── B18: ativação interrompida (cliente pagou e ficou bloqueado) ──────────

  describe('repairStuckActivation', () => {
    const now = new Date('2026-07-28T12:00:00Z');
    const paidCharge = {
      id: 'chg_pago',
      type: 'subscription',
      periodStart: new Date('2026-07-24T00:00:00Z'),
      periodEnd: new Date('2027-07-24T00:00:00Z'),
      paidAt: new Date('2026-07-24T10:00:00Z'),
    };

    it('cobrança paga cobrindo hoje + assinatura readonly → ativa com o período da cobrança', async () => {
      const repo = makeRepo({
        findSubscriptionByCompany: jest.fn().mockResolvedValue({
          id: 'sub_1',
          status: 'readonly',
          superadminLocked: false,
          currentPeriodEnd: null,
          seatsAtNextRenewal: null,
        }),
        findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(paidCharge),
      });
      const service = makeService(repo, makeAsaas(null));

      await expect(service.repairStuckActivation('c1', now)).resolves.toBe(true);

      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({
          status: 'active',
          graceUntil: null,
          currentPeriodStart: paidCharge.periodStart,
          currentPeriodEnd: paidCharge.periodEnd,
        }),
      );
      expect(access.invalidate).toHaveBeenCalledWith('c1');
    });

    it('ciclo em dia com status bloqueado também é curado (C17)', async () => {
      // Resíduo do bug em que travar pelo superadmin marcava a assinatura como
      // vencida: o anual seguia pago até 2027 e a empresa ficava presa em readonly.
      const repo = makeRepo({
        findSubscriptionByCompany: jest.fn().mockResolvedValue({
          id: 'sub_1',
          status: 'readonly',
          superadminLocked: false,
          currentPeriodEnd: new Date('2027-07-24T00:00:00Z'),
          seatsAtNextRenewal: null,
        }),
        findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(paidCharge),
      });
      const service = makeService(repo, makeAsaas(null));

      await expect(service.repairStuckActivation('c1', now)).resolves.toBe(true);
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ status: 'active' }),
      );
    });

    it('não mexe em assinatura já ativa', async () => {
      const repo = makeRepo({
        findSubscriptionByCompany: jest
          .fn()
          .mockResolvedValue({ id: 'sub_1', status: 'active', superadminLocked: false }),
      });
      const service = makeService(repo, makeAsaas(null));
      await expect(service.repairStuckActivation('c1', now)).resolves.toBe(false);
      expect(repo.updateSubscription).not.toHaveBeenCalled();
    });

    it('respeita a trava manual do superadmin, mas ALERTA (cliente em dia e bloqueado — C13)', async () => {
      const repo = makeRepo({
        findSubscriptionByCompany: jest.fn().mockResolvedValue({
          id: 'sub_1',
          status: 'readonly',
          superadminLocked: true,
          currentPeriodEnd: null,
        }),
        findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(paidCharge),
      });
      const service = makeService(repo, makeAsaas(null));
      await expect(service.repairStuckActivation('c1', now)).resolves.toBe(false);
      expect(repo.updateSubscription).not.toHaveBeenCalled();
      expect(alerts.raise).toHaveBeenCalledWith(
        'payment_blocked_by_lock',
        expect.objectContaining({ companyId: 'c1', chargeId: 'chg_pago' }),
      );
    });

    it('travado e SEM pagamento em dia não vira alerta (bloqueio normal)', async () => {
      const repo = makeRepo({
        findSubscriptionByCompany: jest.fn().mockResolvedValue({
          id: 'sub_1',
          status: 'readonly',
          superadminLocked: true,
          currentPeriodEnd: null,
        }),
        findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(null),
      });
      const service = makeService(repo, makeAsaas(null));
      await expect(service.repairStuckActivation('c1', now)).resolves.toBe(false);
      expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('sem cobrança paga cobrindo hoje, não inventa acesso', async () => {
      const repo = makeRepo({
        findSubscriptionByCompany: jest.fn().mockResolvedValue({
          id: 'sub_1',
          status: 'readonly',
          superadminLocked: false,
          currentPeriodEnd: null,
        }),
        findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(null),
      });
      const service = makeService(repo, makeAsaas(null));
      await expect(service.repairStuckActivation('c1', now)).resolves.toBe(false);
      expect(repo.updateSubscription).not.toHaveBeenCalled();
    });

    it('cancelada não é ressuscitada pela cura', async () => {
      const repo = makeRepo({
        findSubscriptionByCompany: jest.fn().mockResolvedValue({
          id: 'sub_1',
          status: 'canceled',
          superadminLocked: false,
          currentPeriodEnd: null,
        }),
        findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(paidCharge),
      });
      const service = makeService(repo, makeAsaas(null));
      await expect(service.repairStuckActivation('c1', now)).resolves.toBe(false);
    });

    it('aplica a redução de assentos agendada ao curar (R19)', async () => {
      const repo = makeRepo({
        findSubscriptionByCompany: jest.fn().mockResolvedValue({
          id: 'sub_1',
          status: 'past_due',
          superadminLocked: false,
          currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
          seatsAtNextRenewal: 2,
        }),
        findLatestPaidCoveringCharge: jest.fn().mockResolvedValue(paidCharge),
      });
      const service = makeService(repo, makeAsaas(null));
      await service.repairStuckActivation('c1', now);
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ purchasedSeats: 2, seatsAtNextRenewal: null }),
      );
    });
  });

  // ── B3: conciliação por assinatura ────────────────────────────────────────

  it('reconcileSubscription aplica os pagamentos pagos da recorrência', async () => {
    const repo = makeRepo({
      findChargeByAsaasPaymentId: jest.fn().mockResolvedValue({
        id: 'chg_1',
        subscriptionId: 'sub_1',
        companyId: 'c1',
        type: 'renewal',
      }),
      findSubscriptionById: jest
        .fn()
        .mockResolvedValue({ id: 'sub_1', method: 'monthly_card', superadminLocked: false }),
    });
    const asaas = makeAsaas(null, {
      listSubscriptionPayments: jest.fn().mockResolvedValue({
        data: [
          { id: 'pay_1', status: 'RECEIVED', value: 39.9 },
          { id: 'pay_2', status: 'PENDING', value: 39.9 },
        ],
      }),
    } as unknown as Partial<AsaasClient>);
    const service = makeService(repo, asaas);

    await service.reconcileSubscription('asub_1');

    expect(asaas.listSubscriptionPayments).toHaveBeenCalledWith('asub_1');
    expect(repo.markChargePaid).toHaveBeenCalledTimes(1);
  });
});
