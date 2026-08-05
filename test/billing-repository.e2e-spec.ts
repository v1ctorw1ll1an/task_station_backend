import { ConflictException } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { BillingRepository } from '../src/billing/billing.repository';
import { PrismaService } from '../src/prisma/prisma.service';

dotenv.config();

jest.setTimeout(60_000);

/**
 * Repositório de cobrança contra o **Postgres de verdade**.
 *
 * Existe por causa de um prejuízo concreto: o `withCompanyLock` usava
 * `pg_advisory_xact_lock`, que devolve `void` e o driver do Prisma não desserializa
 * — todo checkout respondia 500 em produção. Nenhum teste pegou porque **todas as
 * specs de service mockam o lock**. Regra que fica: query crua, lock e filtro
 * relacional se testam no banco, não no mock.
 */
describe('BillingRepository (e2e — banco real)', () => {
  let prisma: PrismaService;
  let repo: BillingRepository;

  let userId: string;
  let companyId: string;
  let subscriptionId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    repo = new BillingRepository(prisma);

    const suffix = `${Date.now()}`;
    const user = await prisma.user.create({
      data: {
        email: `e2e-repo-${suffix}@test.com`,
        passwordHash: 'x',
        name: 'E2E Repo',
        mustResetPassword: false,
      },
    });
    userId = user.id;
    const company = await prisma.company.create({
      data: { legalName: 'E2E Repo Co', taxId: `e2e-repo-${suffix}`, createdById: userId },
    });
    companyId = company.id;
    await prisma.membership.create({
      data: { userId, resourceType: 'company', resourceId: companyId, role: 'admin' },
    });
    const sub = await prisma.subscription.create({
      data: { companyId, status: 'readonly', method: 'annual_pix', purchasedSeats: 2 },
    });
    subscriptionId = sub.id;
  });

  afterAll(async () => {
    await prisma.billingCharge.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.membership.deleteMany({ where: { resourceId: companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ── Índices em SQL cru: o Prisma não os conhece e já os apagou ────────────

  /**
   * O índice único **parcial** de `billing_charges` é a trava final contra duas
   * cobranças abertas do mesmo intento. Como o Prisma não sabe expressá-lo, ele vive em
   * SQL cru numa migration — e foi exatamente por isso que um `prisma migrate dev`
   * rotineiro o apagou em `20260730124301_company_invites`, sem ninguém notar, junto
   * com o índice de `scheduled_removal_at`.
   *
   * Este teste é a única coisa que faz esse apagão aparecer antes de virar cobrança
   * duplicada em produção.
   */
  describe('índices que o Prisma não gera', () => {
    it('a trava de "uma cobrança aberta por intento" existe no banco', async () => {
      const [row] = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'billing_charges' AND indexname = 'billing_charges_one_open_per_intent'`;

      expect(row).toBeDefined();
      expect(row.indexdef).toContain('UNIQUE');
      expect(row.indexdef).toContain("status = 'pending'");
      // Cobre os dois intentos iniciados pelo cliente.
      expect(row.indexdef).toMatch(/subscription/);
      expect(row.indexdef).toMatch(/seat/);
    });

    it('a varredura de saídas agendadas tem índice', async () => {
      const [row] = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'memberships' AND indexname = 'memberships_scheduled_removal_at_idx'`;
      expect(row).toBeDefined();
    });
  });

  // ── C11: o lock que derrubou o checkout ──────────────────────────────────

  describe('withCompanyLock', () => {
    it('executa a seção crítica e devolve o resultado', async () => {
      await expect(repo.withCompanyLock(companyId, () => Promise.resolve('ok'))).resolves.toBe(
        'ok',
      );
    });

    it('a segunda operação simultânea da mesma empresa é recusada com 409', async () => {
      let liberar!: () => void;
      const segura = new Promise<void>((resolve) => (liberar = resolve));

      const primeira = repo.withCompanyLock(companyId, async () => {
        await segura;
        return 'primeira';
      });
      // Espaço para a primeira transação pegar o cadeado.
      await new Promise((r) => setTimeout(r, 300));

      await expect(
        repo.withCompanyLock(companyId, () => Promise.resolve('segunda')),
      ).rejects.toBeInstanceOf(ConflictException);

      liberar();
      await expect(primeira).resolves.toBe('primeira');
    });

    it('empresas diferentes não disputam o mesmo cadeado', async () => {
      let liberar!: () => void;
      const segura = new Promise<void>((resolve) => (liberar = resolve));

      const primeira = repo.withCompanyLock(companyId, async () => {
        await segura;
        return 'primeira';
      });
      await new Promise((r) => setTimeout(r, 300));

      await expect(
        repo.withCompanyLock(`${companyId}-outra`, () => Promise.resolve('outra')),
      ).resolves.toBe('outra');

      liberar();
      await primeira;
    });

    it('o cadeado é devolvido ao fim da operação', async () => {
      await repo.withCompanyLock(companyId, () => Promise.resolve(1));
      await expect(repo.withCompanyLock(companyId, () => Promise.resolve(2))).resolves.toBe(2);
    });

    it('erro dentro da seção crítica propaga e libera o cadeado', async () => {
      await expect(
        repo.withCompanyLock(companyId, () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      await expect(repo.withCompanyLock(companyId, () => Promise.resolve('livre'))).resolves.toBe(
        'livre',
      );
    });
  });

  // ── Índice único parcial (B2) ────────────────────────────────────────────

  it('o banco recusa uma segunda cobrança aberta do mesmo intento', async () => {
    const base = {
      subscriptionId,
      companyId,
      type: 'subscription' as const,
      paymentKind: 'pix' as const,
      status: 'pending' as const,
      amountCents: 43092,
      installments: 1,
      seats: 1,
    };
    const primeira = await repo.createCharge(base);
    await expect(repo.createCharge(base)).rejects.toMatchObject({ code: 'P2002' });

    // Fechada a primeira, o intento volta a aceitar cobrança nova.
    await repo.updateCharge(primeira.id, { status: 'canceled' });
    const segunda = await repo.createCharge(base);
    expect(segunda.id).not.toBe(primeira.id);
    await prisma.billingCharge.deleteMany({ where: { companyId } });
  });

  // ── Filtros relacionais recém-criados ────────────────────────────────────

  it('findLatestPaidCoveringCharge só devolve cobrança paga que cobre hoje', async () => {
    const agora = new Date();
    await repo.createCharge({
      subscriptionId,
      companyId,
      type: 'subscription',
      paymentKind: 'pix',
      status: 'paid',
      amountCents: 43092,
      installments: 1,
      seats: 1,
      periodStart: new Date(agora.getTime() - 86_400_000),
      periodEnd: new Date(agora.getTime() + 86_400_000),
      paidAt: agora,
    });

    await expect(repo.findLatestPaidCoveringCharge(companyId, agora)).resolves.toMatchObject({
      status: 'paid',
    });
    // Um ano à frente, aquela cobrança não cobre mais nada.
    const futuro = new Date(agora.getTime() + 400 * 86_400_000);
    await expect(repo.findLatestPaidCoveringCharge(companyId, futuro)).resolves.toBeNull();
  });

  it('findStuckSubscriptions encontra quem pagou e ficou bloqueado (B18)', async () => {
    const presas = await repo.findStuckSubscriptions(new Date());
    expect(presas.map((s) => s.companyId)).toContain(companyId);
  });

  it('findStuckSubscriptions ignora empresa travada pelo superadmin', async () => {
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { superadminLocked: true },
    });
    const presas = await repo.findStuckSubscriptions(new Date());
    expect(presas.map((s) => s.companyId)).not.toContain(companyId);
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { superadminLocked: false },
    });
  });

  // ── Saída de assento agendada (R19) ──────────────────────────────────────

  it('agenda e efetiva a saída do membro escolhido', async () => {
    const holders = await repo.findCompanySeatHolders(companyId);
    expect(holders).toHaveLength(1);

    await repo.scheduleSeatRemovals(companyId, [userId], new Date());
    const [agendado] = await repo.findCompanySeatHolders(companyId);
    expect(agendado.scheduledRemovalAt).toBeTruthy();
    // Enquanto não renova, a pessoa continua ocupando o assento.
    await expect(repo.countOccupiedSeats(companyId)).resolves.toBe(1);

    const { count } = await repo.applyScheduledSeatRemovals(companyId, new Date());
    expect(count).toBe(1);
    await expect(repo.countOccupiedSeats(companyId)).resolves.toBe(0);
  });

  it('nova seleção substitui a anterior', async () => {
    await prisma.membership.updateMany({
      where: { resourceId: companyId },
      data: { deletedAt: null, scheduledRemovalAt: null },
    });
    await repo.scheduleSeatRemovals(companyId, [userId], new Date());
    await repo.scheduleSeatRemovals(companyId, [], new Date());

    const [holder] = await repo.findCompanySeatHolders(companyId);
    expect(holder.scheduledRemovalAt).toBeNull();
    await expect(repo.applyScheduledSeatRemovals(companyId, new Date())).resolves.toMatchObject({
      count: 0,
    });
  });
});
