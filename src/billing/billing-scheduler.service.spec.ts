import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';
import { AsaasClient } from './asaas/asaas.client';
import { BillingAccessService } from './billing-access.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingRepository } from './billing.repository';
import { BillingSchedulerService } from './billing-scheduler.service';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';

const NOW = new Date('2026-07-22T12:00:00Z');

function makeRepo(
  overrides: Partial<jest.Mocked<BillingRepository>> = {},
): jest.Mocked<BillingRepository> {
  return {
    findTrials: jest.fn().mockResolvedValue([]),
    findPastDue: jest.fn().mockResolvedValue([]),
    findActiveAnnual: jest.fn().mockResolvedValue([]),
    findCancelDue: jest.fn().mockResolvedValue([]),
    findExpiredCheckoutCharges: jest.fn().mockResolvedValue([]),
    findUnboundCheckoutCharges: jest.fn().mockResolvedValue([]),
    findSeatAddonsPastGrace: jest.fn().mockResolvedValue([]),
    findSubscriptionsWithAddons: jest.fn().mockResolvedValue([]),
    sumActiveAddonSeats: jest.fn().mockResolvedValue(0),
    syncAddonSeats: jest.fn().mockResolvedValue(0),
    updateSeatAddon: jest.fn().mockResolvedValue({}),
    findExpiredPixCharges: jest.fn().mockResolvedValue([]),
    findStalePendingCharges: jest.fn().mockResolvedValue([]),
    findSubscriptionsNeedingSync: jest.fn().mockResolvedValue([]),
    findStuckSubscriptions: jest.fn().mockResolvedValue([]),
    findMonthlyWithAccruedSeats: jest.fn().mockResolvedValue([]),
    findCanceledSince: jest.fn().mockResolvedValue([]),
    purgeCompanyData: jest.fn().mockResolvedValue({ taskIds: [] }),
    findRetriableWebhookEvents: jest.fn().mockResolvedValue([]),
    findLastWebhookEventAt: jest.fn().mockResolvedValue(new Date(NOW.getTime() - 60_000)),
    countLiveSubscriptions: jest.fn().mockResolvedValue(1),
    findCompanyAdminEmails: jest.fn().mockResolvedValue(['admin@co.com']),
    createNotice: jest.fn().mockResolvedValue({}),
    updateSubscription: jest.fn().mockResolvedValue({}),
    updateCharge: jest.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as jest.Mocked<BillingRepository>;
}

function makeMailer() {
  return {
    sendTrialEndingEmail: jest.fn().mockResolvedValue(undefined),
    sendTrialEndedEmail: jest.fn().mockResolvedValue(undefined),
    sendReadOnlyActivatedEmail: jest.fn().mockResolvedValue(undefined),
    sendAnnualRenewalReminderEmail: jest.fn().mockResolvedValue(undefined),
    sendDataRetentionWarningEmail: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailerService>;
}

const access = { invalidate: jest.fn(), isBlocked: jest.fn() } as unknown as BillingAccessService;
const webhook = {
  reconcilePayment: jest.fn().mockResolvedValue(undefined),
  reconcileSubscription: jest.fn().mockResolvedValue(undefined),
  reprocess: jest.fn().mockResolvedValue(undefined),
  repairStuckActivation: jest.fn().mockResolvedValue(false),
} as unknown as jest.Mocked<BillingWebhookService>;
const asaas = {
  deleteSubscription: jest.fn().mockResolvedValue({ deleted: true }),
} as unknown as jest.Mocked<AsaasClient>;
const billing = {
  syncMonthlyValue: jest.fn().mockResolvedValue(undefined),
  cancelarAddonsDaEmpresa: jest.fn().mockResolvedValue(undefined),
  descartarAddonPendente: jest.fn().mockResolvedValue(undefined),
} as unknown as jest.Mocked<BillingService>;
/** Por padrão tudo ligado e a retenção em modo de ensaio (como em produção no início). */
function makeConfig(over: Record<string, string> = {}): ConfigService {
  const base: Record<string, string> = {
    BILLING_ENABLED: 'true',
    BILLING_RETENTION_ENABLED: 'true',
    BILLING_RETENTION_DRY_RUN: 'false',
  };
  return { get: (k: string) => ({ ...base, ...over })[k] } as unknown as ConfigService;
}
const config = makeConfig();
const alerts = {
  raise: jest.fn().mockResolvedValue(undefined),
} as unknown as jest.Mocked<BillingAlertsService>;
const metrics = {
  billingLastWebhookAge: jest.fn(),
  billingWebhook: jest.fn(),
  billingReconcile: jest.fn(),
  billingAlert: jest.fn(),
} as unknown as jest.Mocked<MetricsService>;
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;
const checkout = {
  casarPagamento: jest.fn().mockResolvedValue(null),
  cancelar: jest.fn().mockResolvedValue(undefined),
  resolverAssinatura: jest.fn().mockResolvedValue(null),
} as unknown as jest.Mocked<BillingCheckoutService>;

function make(repo: jest.Mocked<BillingRepository>, cfg: ConfigService = config) {
  const mailer = makeMailer();
  const service = new BillingSchedulerService(
    repo,
    mailer,
    access,
    webhook,
    billing,
    checkout,
    asaas,
    cfg,
    alerts,
    metrics,
    logger,
  );
  return { service, mailer };
}

describe('BillingSchedulerService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('trial vencido → somente-leitura + e-mail de fim de trial', async () => {
    const repo = makeRepo({
      findTrials: jest
        .fn()
        .mockResolvedValue([
          { id: 's1', companyId: 'c1', trialEndsAt: new Date('2026-07-20T00:00:00Z') },
        ]),
    });
    const { service, mailer } = make(repo);
    await service.run(NOW);

    expect(repo.updateSubscription).toHaveBeenCalledWith('s1', { status: 'readonly' });
    expect(access.invalidate).toHaveBeenCalledWith('c1');
    expect(mailer.sendTrialEndedEmail).toHaveBeenCalledWith(['admin@co.com'], 'c1');
  });

  it('trial a 3 dias → e-mail de aviso, sem readonly', async () => {
    const repo = makeRepo({
      findTrials: jest
        .fn()
        .mockResolvedValue([
          { id: 's1', companyId: 'c1', trialEndsAt: new Date('2026-07-25T12:00:00Z') },
        ]),
    });
    const { service, mailer } = make(repo);
    await service.run(NOW);

    expect(repo.updateSubscription).not.toHaveBeenCalled();
    expect(mailer.sendTrialEndingEmail).toHaveBeenCalledWith(['admin@co.com'], 'c1', 3);
  });

  it('e-mail idempotente: aviso já registrado (P2002) não reenvia', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    const repo = makeRepo({
      findTrials: jest
        .fn()
        .mockResolvedValue([
          { id: 's1', companyId: 'c1', trialEndsAt: new Date('2026-07-25T12:00:00Z') },
        ]),
      createNotice: jest.fn().mockRejectedValue(p2002),
    });
    const { service, mailer } = make(repo);
    await service.run(NOW);

    expect(mailer.sendTrialEndingEmail).not.toHaveBeenCalled();
    expect(repo.findCompanyAdminEmails).not.toHaveBeenCalled();
  });

  it('carência do mensal esgotada → somente-leitura + e-mail', async () => {
    const repo = makeRepo({
      findPastDue: jest
        .fn()
        .mockResolvedValue([
          { id: 's2', companyId: 'c2', graceUntil: new Date('2026-07-21T00:00:00Z') },
        ]),
    });
    const { service, mailer } = make(repo);
    await service.run(NOW);

    expect(repo.updateSubscription).toHaveBeenCalledWith('s2', { status: 'readonly' });
    expect(mailer.sendReadOnlyActivatedEmail).toHaveBeenCalledWith(['admin@co.com'], 'c2');
  });

  it('anual vencido → readonly; anual a 7 dias → lembrete', async () => {
    const repo = makeRepo({
      findActiveAnnual: jest.fn().mockResolvedValue([
        { id: 'a1', companyId: 'ca', currentPeriodEnd: new Date('2026-07-10T00:00:00Z') }, // vencido
        { id: 'a2', companyId: 'cb', currentPeriodEnd: new Date('2026-07-29T12:00:00Z') }, // 7 dias
      ]),
    });
    const { service, mailer } = make(repo);
    await service.run(NOW);

    expect(repo.updateSubscription).toHaveBeenCalledWith('a1', { status: 'readonly' });
    expect(mailer.sendAnnualRenewalReminderEmail).toHaveBeenCalledWith(['admin@co.com'], 'cb', 7);
  });

  it('Pix pendente vencido → cobrança expira', async () => {
    const repo = makeRepo({
      findExpiredPixCharges: jest.fn().mockResolvedValue([{ id: 'chg1' }]),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(repo.updateCharge).toHaveBeenCalledWith('chg1', { status: 'expired' });
  });

  it('cancelamento no fim do ciclo (sem recorrência) → canceled, sem chamar o Asaas', async () => {
    const repo = makeRepo({
      findCancelDue: jest
        .fn()
        .mockResolvedValue([{ id: 's3', companyId: 'c3', asaasSubscriptionId: null }]),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(asaas.deleteSubscription).not.toHaveBeenCalled();
    expect(repo.updateSubscription).toHaveBeenCalledWith(
      's3',
      expect.objectContaining({ status: 'canceled' }),
    );
    expect(access.invalidate).toHaveBeenCalledWith('c3');
  });

  it('cancelamento com recorrência ativa → encerra no Asaas antes de marcar canceled', async () => {
    const repo = makeRepo({
      findCancelDue: jest
        .fn()
        .mockResolvedValue([{ id: 's4', companyId: 'c4', asaasSubscriptionId: 'asub_9' }]),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(asaas.deleteSubscription).toHaveBeenCalledWith('asub_9');
    expect(repo.updateSubscription).toHaveBeenCalledWith(
      's4',
      expect.objectContaining({ status: 'canceled', asaasSubscriptionId: null }),
    );
  });

  it('conciliação chama reconcilePayment das cobranças pendentes antigas', async () => {
    const repo = makeRepo({
      findStalePendingCharges: jest
        .fn()
        .mockResolvedValue([{ id: 'chg2', asaasPaymentId: 'pay_9' }]),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(webhook.reconcilePayment).toHaveBeenCalledWith('pay_9', 'cron_charge');
  });

  it('concilia a assinatura recorrente direto no Asaas (renovação sem webhook — B3)', async () => {
    const repo = makeRepo({
      findSubscriptionsNeedingSync: jest
        .fn()
        .mockResolvedValue([{ id: 's9', companyId: 'c9', asaasSubscriptionId: 'asub_9' }]),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(webhook.reconcileSubscription).toHaveBeenCalledWith('asub_9');
  });

  it('ao efetivar o cancelamento, limpa a flag para não contaminar o próximo plano (C1)', async () => {
    const repo = makeRepo({
      findCancelDue: jest
        .fn()
        .mockResolvedValue([{ id: 's5', companyId: 'c5', asaasSubscriptionId: null }]),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(repo.updateSubscription).toHaveBeenCalledWith(
      's5',
      expect.objectContaining({ status: 'canceled', cancelAtPeriodEnd: false, canceledAt: NOW }),
    );
  });

  it('cura empresas que pagaram e ficaram bloqueadas (B18)', async () => {
    const repo = makeRepo({
      findStuckSubscriptions: jest.fn().mockResolvedValue([{ id: 's7', companyId: 'c7' }]),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(webhook.repairStuckActivation).toHaveBeenCalledWith('c7', NOW);
  });

  describe('retenção de dados (R43)', () => {
    const cancelada = (dias: number) => ({
      id: 'sub_ret',
      companyId: 'c_ret',
      canceledAt: new Date(NOW.getTime() - dias * 86_400_000),
    });

    /** Espelha o filtro real do repositório (`canceledAt <= cutoff`). */
    const repoCom = (...assinaturas: ReturnType<typeof cancelada>[]) =>
      makeRepo({
        findCanceledSince: jest
          .fn()
          .mockImplementation((cutoff: Date) =>
            Promise.resolve(assinaturas.filter((a) => a.canceledAt <= cutoff)),
          ),
      });

    it('90 dias após o cancelamento os dados são excluídos', async () => {
      const repo = repoCom(cancelada(95));
      const { service } = make(repo);
      await service.run(NOW);

      expect(repo.purgeCompanyData).toHaveBeenCalledWith('c_ret', NOW);
      expect(alerts.raise).toHaveBeenCalledWith(
        'data_retention_purged',
        expect.objectContaining({ companyId: 'c_ret' }),
      );
    });

    it('modo de ensaio não apaga nada', async () => {
      const repo = repoCom(cancelada(95));
      const { service } = make(repo, makeConfig({ BILLING_RETENTION_DRY_RUN: 'true' }));
      await service.run(NOW);

      expect(repo.purgeCompanyData).not.toHaveBeenCalled();
    });

    it('com a retenção desligada nada é varrido', async () => {
      const repo = repoCom(cancelada(95));
      const { service } = make(repo, makeConfig({ BILLING_RETENTION_ENABLED: 'false' }));
      await service.run(NOW);

      expect(repo.findCanceledSince).not.toHaveBeenCalled();
      expect(repo.purgeCompanyData).not.toHaveBeenCalled();
    });

    it('avisa 30 dias antes da exclusão', async () => {
      const repo = repoCom(cancelada(60));
      const { service, mailer } = make(repo);
      await service.run(NOW);

      expect(mailer.sendDataRetentionWarningEmail).toHaveBeenCalledWith(
        ['admin@co.com'],
        'c_ret',
        30,
      );
      expect(repo.purgeCompanyData).not.toHaveBeenCalled();
    });

    it('cancelada há pouco tempo não recebe aviso nem é apagada', async () => {
      const repo = repoCom(cancelada(10));
      const { service, mailer } = make(repo);
      await service.run(NOW);

      expect(mailer.sendDataRetentionWarningEmail).not.toHaveBeenCalled();
      expect(repo.purgeCompanyData).not.toHaveBeenCalled();
    });
  });

  it('drena a fila de webhooks que falharam (B1)', async () => {
    const repo = makeRepo({
      findRetriableWebhookEvents: jest
        .fn()
        .mockResolvedValue([
          { id: 'evt1', type: 'PAYMENT_CONFIRMED', payload: { id: 'e1' }, attempts: 2 },
        ]),
    });
    const { service } = make(repo);
    await service.drainWebhookQueue(NOW);
    expect(webhook.reprocess).toHaveBeenCalledWith({
      id: 'evt1',
      type: 'PAYMENT_CONFIRMED',
      payload: { id: 'e1' },
      attempts: 2,
    });
  });

  it('silêncio prolongado de webhook com assinatura viva dispara alerta (B9)', async () => {
    const repo = makeRepo({
      findLastWebhookEventAt: jest.fn().mockResolvedValue(new Date('2026-07-20T12:00:00Z')),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(alerts.raise).toHaveBeenCalledWith('webhook_silence', expect.any(Object));
  });

  it('não alarma silêncio quando não há assinatura viva', async () => {
    const repo = makeRepo({
      findLastWebhookEventAt: jest.fn().mockResolvedValue(new Date('2026-07-20T12:00:00Z')),
      countLiveSubscriptions: jest.fn().mockResolvedValue(0),
    });
    const { service } = make(repo);
    await service.run(NOW);
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('uma sub-rotina que falha não derruba as outras', async () => {
    const repo = makeRepo({
      findTrials: jest.fn().mockRejectedValue(new Error('boom')),
      findCancelDue: jest.fn().mockResolvedValue([{ id: 's3', companyId: 'c3' }]),
    });
    const { service } = make(repo);
    await expect(service.run(NOW)).resolves.toBeUndefined();
    expect(repo.updateSubscription).toHaveBeenCalledWith(
      's3',
      expect.objectContaining({ status: 'canceled' }),
    );
  });
});
