import { ConflictException, Injectable } from '@nestjs/common';
import {
  ChargeStatus,
  ChargeType,
  Prisma,
  SeatAddonStatus,
  SubscriptionStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSubscriptionByCompany(companyId: string) {
    return this.prisma.subscription.findUnique({ where: { companyId } });
  }

  /** Só o status — caminho quente do gate de escrita. */
  getSubscriptionStatus(companyId: string) {
    return this.prisma.subscription.findUnique({
      where: { companyId },
      select: { status: true },
    });
  }

  /**
   * Resumo usado pelo gate/paywall. O `method` distingue "nunca assinou" (trial
   * encerrado) de "assinatura vencida", e `superadminLocked` distingue as duas de
   * um bloqueio administrativo — dizer "sua assinatura venceu" para quem está em
   * dia e foi travado à mão é mentira (C13).
   */
  getSubscriptionSummary(companyId: string) {
    return this.prisma.subscription.findUnique({
      where: { companyId },
      select: {
        status: true,
        trialEndsAt: true,
        method: true,
        superadminLocked: true,
        accessSuspended: true,
        currentPeriodEnd: true,
      },
    });
  }

  updateSubscription(id: string, data: Prisma.SubscriptionUpdateInput) {
    return this.prisma.subscription.update({ where: { id }, data });
  }

  /** Assentos ocupados = memberships ativas de empresa. */
  countOccupiedSeats(companyId: string) {
    return this.prisma.membership.count({
      where: { resourceType: 'company', resourceId: companyId, deletedAt: null },
    });
  }

  /** Membros da empresa (para o admin escolher quem sai ao reduzir assentos). */
  findCompanySeatHolders(companyId: string) {
    return this.prisma.membership.findMany({
      where: { resourceType: 'company', resourceId: companyId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        userId: true,
        role: true,
        scheduledRemovalAt: true,
        user: { select: { name: true, email: true } },
      },
    });
  }

  /**
   * Agenda a saída dos membros escolhidos para a próxima renovação (R19) —
   * substitui qualquer agendamento anterior da mesma empresa, para o último
   * pedido do admin ser sempre o que vale.
   */
  async scheduleSeatRemovals(companyId: string, userIds: string[], at: Date): Promise<void> {
    const scope = { resourceType: 'company' as const, resourceId: companyId, deletedAt: null };
    await this.prisma.membership.updateMany({
      where: { ...scope, scheduledRemovalAt: { not: null } },
      data: { scheduledRemovalAt: null },
    });
    if (userIds.length === 0) return;
    await this.prisma.membership.updateMany({
      where: { ...scope, userId: { in: userIds } },
      data: { scheduledRemovalAt: at },
    });
  }

  /** Efetiva as saídas agendadas (soft delete) — chamado quando a renovação é paga. */
  applyScheduledSeatRemovals(companyId: string, now: Date) {
    return this.prisma.membership.updateMany({
      where: {
        resourceType: 'company',
        resourceId: companyId,
        deletedAt: null,
        scheduledRemovalAt: { not: null },
      },
      data: { deletedAt: now, scheduledRemovalAt: null },
    });
  }

  /**
   * Acervo completo da empresa para exportação. Continua disponível com a empresa
   * bloqueada: suspender o **serviço** por falta de pagamento é legítimo, reter o
   * dado do cliente sem saída não é.
   */
  exportCompanyData(companyId: string) {
    return this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: {
        id: true,
        legalName: true,
        taxId: true,
        createdAt: true,
        workspaces: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            description: true,
            createdAt: true,
            projects: {
              where: { deletedAt: null },
              select: {
                id: true,
                name: true,
                description: true,
                createdAt: true,
                columns: {
                  where: { deletedAt: null },
                  orderBy: { order: 'asc' },
                  select: { id: true, name: true, order: true },
                },
                tasks: {
                  where: { deletedAt: null },
                  orderBy: [{ columnId: 'asc' }, { order: 'asc' }],
                  select: {
                    id: true,
                    taskNumber: true,
                    title: true,
                    description: true,
                    priority: true,
                    order: true,
                    columnId: true,
                    startDate: true,
                    dueDate: true,
                    allDay: true,
                    createdAt: true,
                    reporter: { select: { name: true, email: true } },
                    taskAssignees: { select: { user: { select: { name: true, email: true } } } },
                    taskLabels: { select: { label: { select: { name: true } } } },
                    taskChecklists: {
                      orderBy: { order: 'asc' },
                      select: { title: true, completed: true, order: true },
                    },
                    taskComments: {
                      where: { deletedAt: null },
                      orderBy: { createdAt: 'asc' },
                      select: {
                        content: true,
                        createdAt: true,
                        user: { select: { name: true, email: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  /** Dados fiscais da empresa + e-mail do admin mais antigo (para o customer Asaas). */
  async getCompanyFiscal(companyId: string) {
    const [company, adminMembership] = await Promise.all([
      this.prisma.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { legalName: true, taxId: true },
      }),
      this.prisma.membership.findFirst({
        where: { resourceType: 'company', resourceId: companyId, role: 'admin', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { user: { select: { email: true } } },
      }),
    ]);
    if (!company) return null;
    return {
      legalName: company.legalName,
      taxId: company.taxId,
      adminEmail: adminMembership?.user.email,
    };
  }

  createCharge(data: Prisma.BillingChargeUncheckedCreateInput) {
    return this.prisma.billingCharge.create({ data });
  }

  /** Outra empresa (não excluída) já usa este documento? Protege o `@unique`. */
  findCompanyByTaxIdExcluding(taxId: string, excludeId: string) {
    return this.prisma.company.findFirst({
      where: { taxId, id: { not: excludeId }, deletedAt: null },
      select: { id: true },
    });
  }

  updateCompanyFiscal(companyId: string, data: { legalName?: string; taxId?: string }) {
    return this.prisma.company.update({ where: { id: companyId }, data });
  }

  findChargeById(id: string) {
    return this.prisma.billingCharge.findUnique({ where: { id } });
  }

  /**
   * Cobrança pendente mais recente da empresa, de qualquer forma de pagamento — é
   * a que o cliente pode ter acabado de pagar. O `findPendingPixCharge` só enxerga
   * Pix com QR válido; aqui entra também o cartão aguardando confirmação.
   */
  findLatestPendingCharge(companyId: string) {
    return this.prisma.billingCharge.findFirst({
      where: { companyId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Cobrança aberta (pendente) de um mesmo "intento" — a mesma que o índice único
   * parcial `billing_charges_one_open_per_intent` protege. Usada para reaproveitar
   * em vez de criar uma segunda cobrança pagável (B2).
   */
  findOpenChargeByIntent(subscriptionId: string, type: ChargeType) {
    return this.prisma.billingCharge.findFirst({
      where: { subscriptionId, type, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
  }

  findChargeByCheckoutId(asaasCheckoutId: string) {
    return this.prisma.billingCharge.findUnique({ where: { asaasCheckoutId } });
  }

  /**
   * Cobranças de checkout que passaram da validade sem serem pagas. O intento fica
   * travado enquanto elas existirem (índice único parcial), então encerrá-las é o que
   * devolve ao cliente a possibilidade de tentar de novo.
   */
  findExpiredCheckoutCharges(now: Date, limit = 50) {
    return this.prisma.billingCharge.findMany({
      where: { status: 'pending', checkoutExpiresAt: { not: null, lt: now } },
      orderBy: { checkoutExpiresAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Cobranças de checkout ainda dentro da validade mas sem cobrança vinculada há um
   * tempo — candidatas a serem casadas na marra com o que existe no Asaas. É a rede
   * para o caso de o `CHECKOUT_PAID` não chegar (ou não trazer o que precisamos).
   */
  findUnboundCheckoutCharges(criadasAte: Date, limit = 25) {
    return this.prisma.billingCharge.findMany({
      where: {
        status: 'pending',
        asaasCheckoutId: { not: null },
        asaasPaymentId: null,
        createdAt: { lt: criadasAte },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  // ── Assentos adicionais do plano anual (assinaturas próprias) ─────────────

  createSeatAddon(data: Prisma.SeatAddonUncheckedCreateInput) {
    return this.prisma.seatAddon.create({ data });
  }

  updateSeatAddon(id: string, data: Prisma.SeatAddonUpdateInput) {
    return this.prisma.seatAddon.update({ where: { id }, data });
  }

  findSeatAddonById(id: string) {
    return this.prisma.seatAddon.findUnique({ where: { id } });
  }

  findSeatAddonByAsaasSubscription(asaasSubscriptionId: string) {
    return this.prisma.seatAddon.findUnique({ where: { asaasSubscriptionId } });
  }

  /** Add-ons de uma empresa, do mais novo para o mais velho (tela e cancelamento). */
  findSeatAddons(companyId: string, status?: SeatAddonStatus[]) {
    return this.prisma.seatAddon.findMany({
      where: { companyId, ...(status ? { status: { in: status } } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Add-ons vencidos aguardando o fim da carência para deixarem de valer. */
  findSeatAddonsPastGrace(now: Date, limit = 50) {
    return this.prisma.seatAddon.findMany({
      where: { status: 'past_due', graceUntil: { not: null, lt: now } },
      orderBy: { graceUntil: 'asc' },
      take: limit,
    });
  }

  /** Add-ons que renovam em breve — base dos avisos por e-mail. */
  findSeatAddonsRenewingBy(limite: Date, limit = 100) {
    return this.prisma.seatAddon.findMany({
      where: {
        status: { in: ['active', 'past_due'] },
        currentPeriodEnd: { not: null, lte: limite },
      },
      orderBy: { currentPeriodEnd: 'asc' },
      take: limit,
    });
  }

  /**
   * Soma dos assentos que os add-ons dão direito hoje. `past_due` conta: a carência
   * existe justamente para o cliente não perder gente enquanto resolve o pagamento.
   */
  async sumActiveAddonSeats(companyId: string): Promise<number> {
    const { _sum } = await this.prisma.seatAddon.aggregate({
      where: { companyId, status: { in: ['active', 'past_due'] } },
      _sum: { seats: true },
    });
    return _sum.seats ?? 0;
  }

  /**
   * Recalcula `Subscription.addonSeats` a partir da tabela e devolve o valor. O
   * contador é desnormalizado para não pesar o caminho quente de contratar membro —
   * esta é a reconciliação que impede a divergência de virar assento fantasma.
   */
  async syncAddonSeats(subscriptionId: string, companyId: string): Promise<number> {
    const total = await this.sumActiveAddonSeats(companyId);
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { addonSeats: total },
    });
    return total;
  }

  /** Assinaturas com add-ons — varredura do cron de reconciliação. */
  findSubscriptionsWithAddons(limit = 50) {
    return this.prisma.subscription.findMany({
      where: { seatAddons: { some: {} } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, companyId: true, addonSeats: true },
    });
  }

  /**
   * Serializa uma seção crítica por empresa com advisory lock do Postgres — mata a
   * corrida de duplo clique/duas abas no checkout (B2). O lock é de transação: a
   * função roda enquanto a transação segura o cadeado (as escritas de `fn` usam o
   * cliente normal e NÃO são revertidas — o objetivo aqui é exclusão mútua, não
   * atomicidade).
   *
   * Usa a variante `try_`: ela devolve **boolean** (o `pg_advisory_xact_lock` puro
   * devolve `void`, que o driver do Prisma não consegue desserializar — era o 500 de
   * todo checkout, C11) e não fica esperando. Quem chega no meio de outra operação
   * leva 409 na hora, que é o comportamento certo para duplo clique: a segunda
   * tentativa não deve virar uma segunda cobrança nem ficar pendurada.
   */
  withCompanyLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${companyId})) AS locked`;
        if (!row?.locked) {
          throw new ConflictException(
            'Já existe uma operação de cobrança em andamento para esta empresa. Aguarde alguns segundos e tente de novo.',
          );
        }
        return fn();
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  updateCharge(id: string, data: Prisma.BillingChargeUpdateInput) {
    return this.prisma.billingCharge.update({ where: { id }, data });
  }

  findCharges(companyId: string, page: number, limit: number) {
    return Promise.all([
      this.prisma.billingCharge.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.billingCharge.count({ where: { companyId } }),
    ]);
  }

  /**
   * Última cobrança Pix pendente **utilizável** (para exibir o QR no status): exige
   * QR gerado e ainda não expirado — cobrança órfã (sem payload) ou vencida não vai
   * para a tela (B5).
   */
  findPendingPixCharge(companyId: string, now: Date = new Date()) {
    return this.prisma.billingCharge.findFirst({
      where: {
        companyId,
        paymentKind: 'pix',
        status: 'pending',
        pixPayload: { not: null },
        pixExpiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Webhook (inbox + fila de reprocessamento) ─────────────────────────────

  createWebhookEvent(data: Prisma.WebhookEventUncheckedCreateInput) {
    return this.prisma.webhookEvent.create({ data });
  }

  markWebhookProcessed(id: string, status: 'processed' | 'ignored' | 'failed', error?: string) {
    return this.prisma.webhookEvent.update({
      where: { id },
      data: { status, error: error ?? null, processedAt: new Date(), nextAttemptAt: null },
    });
  }

  /**
   * Eventos gravados que ainda não fecharam e já podem ser reprocessados: os que
   * falharam (`failed`, com a hora da retentativa vencida) **e** os que ficaram
   * presos em `received` porque o processo morreu no meio do processamento — sem
   * estes últimos, um crash entre gravar e processar deixaria o evento órfão.
   */
  findRetriableWebhookEvents(now: Date, limit: number) {
    return this.prisma.webhookEvent.findMany({
      where: { status: { in: ['received', 'failed'] }, nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /** Agenda a próxima tentativa de um evento que falhou (backoff). */
  scheduleWebhookRetry(id: string, attempts: number, nextAttemptAt: Date, error: string) {
    return this.prisma.webhookEvent.update({
      where: { id },
      data: { status: 'failed', attempts, nextAttemptAt, error, processedAt: null },
    });
  }

  /** Esgotou as tentativas — exige ação humana (aparece no financeiro do superadmin). */
  markWebhookDead(id: string, attempts: number, error: string) {
    return this.prisma.webhookEvent.update({
      where: { id },
      data: { status: 'dead', attempts, nextAttemptAt: null, error, processedAt: new Date() },
    });
  }

  /**
   * Empresas canceladas há tempo suficiente para entrar na régua de retenção.
   * Cortesia e trava do superadmin ficam de fora — são decisões humanas, não
   * abandono.
   */
  findCanceledSince(cutoff: Date, limit = 50) {
    return this.prisma.subscription.findMany({
      where: {
        status: 'canceled',
        superadminLocked: false,
        canceledAt: { not: null, lte: cutoff },
      },
      select: { id: true, companyId: true, canceledAt: true },
      orderBy: { canceledAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Apaga o acervo da empresa (retenção vencida). Soft delete na empresa + remoção
   * real do conteúdo, numa transação. Devolve os ids das tasks para o chamador
   * limpar os diretórios de anexo (`uploads/attachments/<taskId>`) — arquivo órfão
   * no volume é o que costuma sobrar.
   */
  async purgeCompanyData(companyId: string, now: Date): Promise<{ taskIds: string[] }> {
    const projetos = await this.prisma.project.findMany({
      where: { workspace: { companyId } },
      select: { id: true },
    });
    const projectIds = projetos.map((p) => p.id);
    const tasks = await this.prisma.task.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    });
    const taskIds = tasks.map((t) => t.id);

    await this.prisma.$transaction([
      this.prisma.taskAttachment.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.taskComment.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.taskChecklist.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.taskHistory.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.taskAssignee.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.taskLabel.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.taskSession.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.taskGuest.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.notification.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.stickyNoteTaskLink.deleteMany({ where: { taskId: { in: taskIds } } }),
      this.prisma.calendarEvent.deleteMany({ where: { companyId } }),
      this.prisma.task.deleteMany({ where: { projectId: { in: projectIds } } }),
      this.prisma.label.deleteMany({ where: { projectId: { in: projectIds } } }),
      this.prisma.column.deleteMany({ where: { projectId: { in: projectIds } } }),
      this.prisma.projectRestriction.deleteMany({ where: { projectId: { in: projectIds } } }),
      this.prisma.project.deleteMany({ where: { id: { in: projectIds } } }),
      this.prisma.workspace.deleteMany({ where: { companyId } }),
      this.prisma.membership.updateMany({
        where: { resourceType: 'company', resourceId: companyId, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.company.update({ where: { id: companyId }, data: { deletedAt: now } }),
    ]);

    return { taskIds };
  }

  /** Momento do último webhook recebido — base do alarme de fila interrompida (B9). */
  async findLastWebhookEventAt(): Promise<Date | null> {
    const last = await this.prisma.webhookEvent.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt ?? null;
  }

  /** Existe alguma assinatura paga viva? (só alarmamos fila morta se sim). */
  countLiveSubscriptions() {
    return this.prisma.subscription.count({
      where: { status: { in: ['active', 'past_due'] } },
    });
  }

  findChargeByAsaasPaymentId(asaasPaymentId: string) {
    return this.prisma.billingCharge.findUnique({ where: { asaasPaymentId } });
  }

  /**
   * Última cobrança **paga** cujo período ainda cobre hoje (B18). É a prova de que a
   * empresa deveria estar ativa — usada para curar ativação interrompida.
   */
  findLatestPaidCoveringCharge(companyId: string, now: Date) {
    return this.prisma.billingCharge.findFirst({
      where: {
        companyId,
        status: 'paid',
        type: { in: ['subscription', 'renewal'] },
        periodEnd: { gt: now },
      },
      orderBy: { paidAt: 'desc' },
    });
  }

  /**
   * Assinaturas bloqueadas/sem ciclo que têm cobrança paga cobrindo hoje — ficaram
   * presas entre "marcar pago" e "ativar" (B18). Cliente pagou e não tem acesso.
   */
  findStuckSubscriptions(now: Date, limit = 50) {
    return this.prisma.subscription.findMany({
      where: {
        superadminLocked: false,
        status: { in: ['trial', 'readonly', 'past_due'] },
        // Sem filtro por `currentPeriodEnd`: a inconsistência mais comum é
        // exatamente ciclo em dia com status bloqueado (C17). O que qualifica é a
        // cobrança paga cobrindo hoje.
        charges: {
          some: {
            status: 'paid',
            type: { in: ['subscription', 'renewal'] },
            periodEnd: { gt: now },
          },
        },
      },
      select: { id: true, companyId: true },
      take: limit,
    });
  }

  /** Marca a cobrança como paga só se ainda não estava — corrida-safe. */
  markChargePaid(id: string) {
    return this.prisma.billingCharge.updateMany({
      where: { id, status: { not: 'paid' } },
      data: { status: 'paid', paidAt: new Date() },
    });
  }

  findSubscriptionById(id: string) {
    return this.prisma.subscription.findUnique({ where: { id } });
  }

  findSubscriptionByAsaasSubscriptionId(asaasSubscriptionId: string) {
    return this.prisma.subscription.findFirst({ where: { asaasSubscriptionId } });
  }

  /**
   * Empresa dona de um cliente do Asaas. Mantemos um customer por empresa, então é
   * chave suficiente — e é a única que sobra quando o pagamento nasce de um checkout
   * que não propagou a nossa referência.
   */
  findSubscriptionByAsaasCustomerId(asaasCustomerId: string) {
    return this.prisma.subscription.findFirst({ where: { asaasCustomerId } });
  }

  // ── Superadmin (financeiro) ────────────────────────────────────────────────

  /**
   * Matéria-prima do resumo financeiro: as assinaturas que geram receita, agrupadas
   * por método e assentos. Só `status` e `purchasedSeats` saem do banco — o preço é
   * calculado por `pricing.ts`, as mesmas funções que cobram, para o painel não
   * inventar um número diferente do que o cliente paga.
   */
  subscriptionsForRevenue() {
    return this.prisma.subscription.groupBy({
      by: ['status', 'method', 'purchasedSeats'],
      _count: { _all: true },
    });
  }

  /** Soma e conta cobranças num intervalo, por status (recebido no mês / a receber). */
  async sumCharges(status: ChargeStatus, campo: 'paidAt' | 'createdAt', desde: Date, ate: Date) {
    const r = await this.prisma.billingCharge.aggregate({
      where: { status, [campo]: { gte: desde, lt: ate } },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    return { totalCents: r._sum.amountCents ?? 0, count: r._count._all };
  }

  /** Cobranças pendentes ainda pagáveis — o que se espera receber. */
  async sumOpenCharges() {
    const r = await this.prisma.billingCharge.aggregate({
      where: { status: 'pending' },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    return { totalCents: r._sum.amountCents ?? 0, count: r._count._all };
  }

  /** Assinaturas que renovam numa janela — quanto está por vir e de quem. */
  findRenewalsBetween(desde: Date, ate: Date) {
    return this.prisma.subscription.findMany({
      where: { status: 'active', currentPeriodEnd: { gte: desde, lt: ate } },
      select: {
        companyId: true,
        method: true,
        purchasedSeats: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        company: { select: { legalName: true } },
      },
      orderBy: { currentPeriodEnd: 'asc' },
    });
  }

  /** Trials terminando na janela — quem está prestes a decidir. */
  countTrialsEndingBefore(ate: Date) {
    return this.prisma.subscription.count({
      where: { status: 'trial', trialEndsAt: { lt: ate } },
    });
  }

  /** Cancelamentos efetivados no intervalo (churn). */
  countCanceledBetween(desde: Date, ate: Date) {
    return this.prisma.subscription.count({
      where: { canceledAt: { gte: desde, lt: ate } },
    });
  }

  listSubscriptions(
    filter: { search?: string; status?: SubscriptionStatus },
    page: number,
    limit: number,
  ) {
    const where: Prisma.SubscriptionWhereInput = {};
    if (filter.status) where.status = filter.status;
    if (filter.search) {
      where.company = {
        deletedAt: null,
        OR: [
          { legalName: { contains: filter.search, mode: 'insensitive' } },
          { taxId: { contains: filter.search, mode: 'insensitive' } },
        ],
      };
    }
    return Promise.all([
      this.prisma.subscription.findMany({
        where,
        include: {
          company: { select: { id: true, legalName: true, taxId: true, isActive: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.subscription.count({ where }),
    ]);
  }

  /** Assentos ocupados por empresa (para a listagem, evitando N+1). */
  occupiedSeatsByCompany(companyIds: string[]) {
    return this.prisma.membership.groupBy({
      by: ['resourceId'],
      where: { resourceType: 'company', resourceId: { in: companyIds }, deletedAt: null },
      _count: { _all: true },
    });
  }

  /** Todas as cobranças de uma empresa (histórico financeiro completo). */
  findAllCharges(companyId: string, take = 200) {
    return this.prisma.billingCharge.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  listWebhookEvents(filter: { status?: string; type?: string }, page: number, limit: number) {
    const where: Prisma.WebhookEventWhereInput = {};
    if (filter.status) where.status = filter.status;
    if (filter.type) where.type = { contains: filter.type, mode: 'insensitive' };
    return Promise.all([
      this.prisma.webhookEvent.findMany({
        where,
        select: {
          id: true,
          asaasEventId: true,
          type: true,
          asaasPaymentId: true,
          status: true,
          processedAt: true,
          error: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.webhookEvent.count({ where }),
    ]);
  }

  /** Um evento de webhook com o payload completo (detalhe). */
  findWebhookEventById(id: string) {
    return this.prisma.webhookEvent.findUnique({ where: { id } });
  }

  // ── Cron (scheduler) ────────────────────────────────────────────────────────

  findTrials() {
    return this.prisma.subscription.findMany({
      where: { status: 'trial' },
      select: { id: true, companyId: true, trialEndsAt: true },
    });
  }

  findPastDue() {
    return this.prisma.subscription.findMany({
      where: { status: 'past_due' },
      select: { id: true, companyId: true, graceUntil: true },
    });
  }

  /**
   * Anuais que **não renovam sozinhos** — só o cartão. O anual no Pix virou assinatura
   * nativa do Asaas: ele gera a cobrança do ano seguinte, e a falta de pagamento chega
   * como `PAYMENT_OVERDUE` (carência, igual ao mensal). Varrer os dois aqui poria em
   * somente-leitura um cliente cuja renovação está a caminho.
   */
  findActiveAnnual() {
    return this.prisma.subscription.findMany({
      where: { status: 'active', method: 'annual_card' },
      select: { id: true, companyId: true, currentPeriodEnd: true },
    });
  }

  /**
   * Cancelamentos a efetivar. Inclui `readonly`/`past_due` porque as sub-rotinas de
   * vencimento rodam antes e podem ter tirado a assinatura de `active` — sem isso o
   * cancelamento nunca se concretizava e a flag ficava pendurada para sempre (C2).
   */
  findCancelDue(now: Date) {
    return this.prisma.subscription.findMany({
      where: {
        status: { in: ['active', 'past_due', 'readonly'] },
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { lte: now },
      },
      select: { id: true, companyId: true, asaasSubscriptionId: true },
    });
  }

  findExpiredPixCharges(now: Date) {
    return this.prisma.billingCharge.findMany({
      where: { status: 'pending', paymentKind: 'pix', pixExpiresAt: { lt: now } },
      select: { id: true },
    });
  }

  /**
   * Assinaturas cujo ciclo precisa ser conferido direto no Asaas (B3): recorrência
   * viva e ciclo indefinido ou já no fim. Cobre o caso em que a renovação mensal
   * (cobrança criada pelo Asaas) nunca chegou por webhook.
   */
  findSubscriptionsNeedingSync(cutoff: Date, limit = 100) {
    return this.prisma.subscription.findMany({
      where: {
        asaasSubscriptionId: { not: null },
        status: { in: ['trial', 'active', 'past_due'] },
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lte: cutoff } }],
      },
      select: { id: true, companyId: true, asaasSubscriptionId: true },
      take: limit,
    });
  }

  /** Cobranças pendentes antigas (rede de segurança p/ webhook perdido). */
  findStalePendingCharges(cutoff: Date) {
    return this.prisma.billingCharge.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff }, asaasPaymentId: { not: null } },
      select: { id: true, asaasPaymentId: true },
    });
  }

  /**
   * Cobranças pendentes **recentes** da empresa (conciliação sob demanda ao abrir a
   * cobrança). Limitada por idade e quantidade para não transformar o `getStatus`
   * numa rajada de chamadas ao Asaas (B7) — o que passa disso é do cron.
   */
  findPendingChargesByCompany(companyId: string, since: Date, take = 3) {
    return this.prisma.billingCharge.findMany({
      where: {
        companyId,
        status: 'pending',
        asaasPaymentId: { not: null },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, asaasPaymentId: true },
      take,
    });
  }

  async findCompanyAdminEmails(companyId: string): Promise<string[]> {
    const rows = await this.prisma.membership.findMany({
      where: { resourceType: 'company', resourceId: companyId, role: 'admin', deletedAt: null },
      select: { user: { select: { email: true } } },
    });
    return rows.map((r) => r.user.email);
  }

  /** Registra um aviso enviado (idempotência de e-mails). Lança P2002 se duplicado. */
  createNotice(data: { subscriptionId: string; kind: string; anchorAt: Date }) {
    return this.prisma.billingNotice.create({ data });
  }
}
