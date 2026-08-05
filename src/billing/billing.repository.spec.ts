import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BillingRepository } from './billing.repository';

function makePrisma() {
  const prisma = {
    billingCharge: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
    },
    webhookEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    membership: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return prisma as unknown as jest.Mocked<PrismaService> & typeof prisma;
}

const NOW = new Date('2026-07-28T12:00:00Z');

/**
 * O repositório é onde várias regras viram filtro de query — e um filtro errado aqui
 * não quebra teste nenhum de service, só some com dinheiro em produção. Este spec
 * fixa as condições que realmente importam.
 */
describe('BillingRepository', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let repo: BillingRepository;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new BillingRepository(prisma);
  });

  describe('cobranças', () => {
    it('markChargePaid só marca o que ainda não está pago (corrida-safe)', async () => {
      await repo.markChargePaid('chg_1');
      expect(prisma.billingCharge.updateMany).toHaveBeenCalledWith({
        where: { id: 'chg_1', status: { not: 'paid' } },
        data: expect.objectContaining({ status: 'paid', paidAt: expect.any(Date) }),
      });
    });

    it('findPendingPixCharge exige QR gerado e não expirado (B5 — nada de QR fantasma)', async () => {
      await repo.findPendingPixCharge('c1', NOW);
      expect(prisma.billingCharge.findFirst).toHaveBeenCalledWith({
        where: {
          companyId: 'c1',
          paymentKind: 'pix',
          status: 'pending',
          pixPayload: { not: null },
          pixExpiresAt: { gt: NOW },
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('findOpenChargeByIntent busca só cobrança pendente do mesmo tipo (B2)', async () => {
      await repo.findOpenChargeByIntent('sub_1', 'seat');
      expect(prisma.billingCharge.findFirst).toHaveBeenCalledWith({
        where: { subscriptionId: 'sub_1', type: 'seat', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('conciliação sob demanda é limitada por janela e quantidade (B7)', async () => {
      const since = new Date('2026-07-26T12:00:00Z');
      await repo.findPendingChargesByCompany('c1', since, 3);
      expect(prisma.billingCharge.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId: 'c1',
            status: 'pending',
            asaasPaymentId: { not: null },
            createdAt: { gte: since },
          }),
          take: 3,
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('a conciliação do cron só olha cobrança pendente já com pagamento no Asaas', async () => {
      const cutoff = new Date('2026-07-28T06:00:00Z');
      await repo.findStalePendingCharges(cutoff);
      expect(prisma.billingCharge.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'pending', createdAt: { lt: cutoff }, asaasPaymentId: { not: null } },
        }),
      );
    });

    it('só expira Pix pendente já vencido', async () => {
      await repo.findExpiredPixCharges(NOW);
      expect(prisma.billingCharge.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'pending', paymentKind: 'pix', pixExpiresAt: { lt: NOW } },
        }),
      );
    });
  });

  describe('fila de webhooks (B1)', () => {
    it('reprocessa tanto os `failed` quanto os `received` presos', async () => {
      await repo.findRetriableWebhookEvents(NOW, 50);
      expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith({
        where: { status: { in: ['received', 'failed'] }, nextAttemptAt: { lte: NOW } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
    });

    it('fechar o evento limpa a retentativa agendada', async () => {
      await repo.markWebhookProcessed('evt_1', 'processed');
      expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt_1' },
        data: expect.objectContaining({ status: 'processed', nextAttemptAt: null }),
      });
    });

    it('agendar retentativa mantém o evento aberto (sem processedAt)', async () => {
      const next = new Date('2026-07-28T12:05:00Z');
      await repo.scheduleWebhookRetry('evt_1', 2, next, 'asaas down');
      expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt_1' },
        data: {
          status: 'failed',
          attempts: 2,
          nextAttemptAt: next,
          error: 'asaas down',
          processedAt: null,
        },
      });
    });

    it('evento morto sai da fila e fica registrado para ação humana', async () => {
      await repo.markWebhookDead('evt_1', 7, 'esgotou');
      expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt_1' },
        data: expect.objectContaining({ status: 'dead', attempts: 7, nextAttemptAt: null }),
      });
    });
  });

  describe('ativação interrompida (B18)', () => {
    it('procura cobrança paga cujo período ainda cobre hoje', async () => {
      await repo.findLatestPaidCoveringCharge('c1', NOW);
      expect(prisma.billingCharge.findFirst).toHaveBeenCalledWith({
        where: {
          companyId: 'c1',
          status: 'paid',
          type: { in: ['subscription', 'renewal'] },
          periodEnd: { gt: NOW },
        },
        orderBy: { paidAt: 'desc' },
      });
    });

    it('varre bloqueadas com pagamento válido — inclusive com ciclo em dia (C17)', async () => {
      await repo.findStuckSubscriptions(NOW);
      expect(prisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            superadminLocked: false,
            status: { in: ['trial', 'readonly', 'past_due'] },
            charges: {
              some: {
                status: 'paid',
                type: { in: ['subscription', 'renewal'] },
                periodEnd: { gt: NOW },
              },
            },
          },
        }),
      );
    });
  });

  describe('conciliação por assinatura (B3)', () => {
    it('pega só assinaturas vivas com recorrência e ciclo vencido/indefinido', async () => {
      const cutoff = new Date('2026-07-29T12:00:00Z');
      await repo.findSubscriptionsNeedingSync(cutoff);
      expect(prisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            asaasSubscriptionId: { not: null },
            status: { in: ['trial', 'active', 'past_due'] },
            OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lte: cutoff } }],
          },
        }),
      );
    });

    it('o alarme de fila parada só conta assinaturas pagas vivas', async () => {
      await repo.countLiveSubscriptions();
      expect(prisma.subscription.count).toHaveBeenCalledWith({
        where: { status: { in: ['active', 'past_due'] } },
      });
    });
  });

  describe('assentos e cancelamento', () => {
    it('assento ocupado = membership de empresa não excluída (soft delete)', async () => {
      await repo.countOccupiedSeats('c1');
      expect(prisma.membership.count).toHaveBeenCalledWith({
        where: { resourceType: 'company', resourceId: 'c1', deletedAt: null },
      });
    });

    it('cancelamento a efetivar cobre também quem já saiu de `active` no meio da rodada (C2)', async () => {
      await repo.findCancelDue(NOW);
      expect(prisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { in: ['active', 'past_due', 'readonly'] },
            cancelAtPeriodEnd: true,
            currentPeriodEnd: { lte: NOW },
          },
          select: expect.objectContaining({ asaasSubscriptionId: true }),
        }),
      );
    });

    it('e-mails de admin ignoram membership excluída', async () => {
      await repo.findCompanyAdminEmails('c1');
      expect(prisma.membership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resourceType: 'company', resourceId: 'c1', role: 'admin', deletedAt: null },
        }),
      );
    });
  });

  describe('withCompanyLock (B2)', () => {
    it('roda a seção crítica dentro da transação que segura o cadeado', async () => {
      // `pg_try_advisory_xact_lock` devolve boolean — `void` quebrava o driver (C11).
      const tx = { $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]) };
      prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      );
      const work = jest.fn().mockResolvedValue('feito');

      await expect(repo.withCompanyLock('c1', work)).resolves.toBe('feito');
      expect(tx.$queryRaw).toHaveBeenCalled(); // pg_advisory_xact_lock
      expect(work).toHaveBeenCalled();
    });

    it('recusa a operação quando outra já segura o cadeado (C11)', async () => {
      const tx = { $queryRaw: jest.fn().mockResolvedValue([{ locked: false }]) };
      prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      );
      const work = jest.fn();

      await expect(repo.withCompanyLock('c1', work)).rejects.toBeInstanceOf(ConflictException);
      expect(work).not.toHaveBeenCalled();
    });

    it('usa timeout folgado — há chamadas ao Asaas dentro do cadeado', async () => {
      prisma.$transaction.mockResolvedValue(undefined);
      await repo.withCompanyLock('c1', jest.fn());
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      const opts = prisma.$transaction.mock.calls[0][1] as { timeout: number };
      expect(opts.timeout).toBeGreaterThanOrEqual(30_000);
    });
  });
});
