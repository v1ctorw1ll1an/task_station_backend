import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, addMonths, startOfMonth } from 'date-fns';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Subscription } from '../generated/prisma/client';
import { AsaasClient } from './asaas/asaas.client';
import { BillingAccessService } from './billing-access.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';
import {
  AdjustSeatsDto,
  CancelSubscriptionDto,
  CourtesyDto,
  ExtendTrialDto,
  ListSubscriptionsQueryDto,
  ListWebhooksQueryDto,
  SetReadonlyDto,
  SuspendAccessDto,
} from './dto/superadmin-billing.dto';
import {
  ANNUAL_SEAT_CENTS,
  annualTotalCents,
  entitledSeats,
  monthlyTotalCents,
  monthlyValueReais,
} from './pricing';

/**
 * Operações financeiras do superusuário sobre qualquer empresa: visão de
 * assinaturas, histórico de cobranças, log de webhooks e ações de gestão
 * (assentos, cortesia, trial, cancelamento, somente-leitura).
 */
@Injectable()
export class SuperadminBillingService {
  constructor(
    private readonly repo: BillingRepository,
    private readonly asaas: AsaasClient,
    private readonly access: BillingAccessService,
    private readonly webhook: BillingWebhookService,
    private readonly billing: BillingService,
    @InjectPinoLogger(SuperadminBillingService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Leitura ──────────────────────────────────────────────────────────────

  /**
   * O resumo que faltava para operar a cobrança: até aqui só existia a lista empresa
   * a empresa, sem nenhum número agregado.
   *
   * **MRR** normaliza o anual dividindo por 12 — sem isso um cliente anual pareceria
   * valer 12× um mensal no mesmo mês. `courtesy` e `trial` não entram: não pagam.
   * Os preços saem de `pricing.ts`, as mesmas funções que cobram.
   */
  async getRevenueSummary() {
    const now = new Date();
    const inicioDoMes = startOfMonth(now);
    const proximoMes = addMonths(inicioDoMes, 1);

    const [grupos, recebido, aReceber, renovacoes, trialsTerminando, cancelados] =
      await Promise.all([
        this.repo.subscriptionsForRevenue(),
        this.repo.sumCharges('paid', 'paidAt', inicioDoMes, proximoMes),
        this.repo.sumOpenCharges(),
        this.repo.findRenewalsBetween(now, addDays(now, 30)),
        this.repo.countTrialsEndingBefore(addDays(now, 7)),
        this.repo.countCanceledBetween(inicioDoMes, proximoMes),
      ]);

    let mrrCents = 0;
    let mrrEmRiscoCents = 0;
    let ativas = 0;
    let inadimplentes = 0;
    for (const g of grupos) {
      const qtd = g._count._all;
      const anual = g.method === 'annual_pix' || g.method === 'annual_card';
      // O anual entra normalizado: 1/12 do ano, para comparar com o mensal.
      const porAssinatura = anual
        ? Math.round(annualTotalCents(g.purchasedSeats) / 12)
        : monthlyTotalCents(g.purchasedSeats);

      if (g.status === 'active') {
        mrrCents += porAssinatura * qtd;
        ativas += qtd;
      } else if (g.status === 'past_due' || g.status === 'readonly') {
        // Receita que já foi conquistada e está prestes a evaporar — é o número que
        // diz se vale a pena ligar para o cliente.
        mrrEmRiscoCents += porAssinatura * qtd;
        inadimplentes += qtd;
      }
    }

    return {
      mrrCents,
      ativas,
      inadimplencia: { count: inadimplentes, mrrEmRiscoCents },
      recebidoNoMes: recebido,
      aReceber,
      trialsTerminando,
      canceladosNoMes: cancelados,
      proximasRenovacoes: renovacoes.map((r) => ({
        companyId: r.companyId,
        legalName: r.company.legalName,
        method: r.method,
        currentPeriodEnd: r.currentPeriodEnd,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
        valorCents:
          r.method === 'annual_pix' || r.method === 'annual_card'
            ? annualTotalCents(r.purchasedSeats)
            : monthlyTotalCents(r.purchasedSeats),
      })),
    };
  }

  async listSubscriptions(query: ListSubscriptionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [rows, total] = await this.repo.listSubscriptions(
      { search: query.search, status: query.status },
      page,
      limit,
    );

    const occupancy = await this.repo.occupiedSeatsByCompany(rows.map((r) => r.companyId));
    const occByCompany = new Map(occupancy.map((o) => [o.resourceId, o._count._all]));

    const data = rows.map((sub) => {
      const occupiedSeats = occByCompany.get(sub.companyId) ?? 0;
      return {
        companyId: sub.companyId,
        company: sub.company,
        status: sub.status,
        method: sub.method,
        purchasedSeats: entitledSeats(sub),
        planSeats: sub.purchasedSeats,
        addonSeats: sub.addonSeats,
        occupiedSeats,
        availableSeats: entitledSeats(sub) - occupiedSeats,
        currentPeriodEnd: sub.currentPeriodEnd,
        trialEndsAt: sub.trialEndsAt,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        superadminLocked: sub.superadminLocked,
        monthlyCents: monthlyTotalCents(sub.purchasedSeats),
        annualCents: annualTotalCents(sub.purchasedSeats),
      };
    });

    return { data, total, page, limit };
  }

  async getCompanyDetail(companyId: string) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    const [charges, occupiedSeats, fiscal, seatAddons] = await Promise.all([
      this.repo.findAllCharges(companyId),
      this.repo.countOccupiedSeats(companyId),
      this.repo.getCompanyFiscal(companyId),
      this.repo.findSeatAddons(companyId),
    ]);
    return {
      company: fiscal ? { legalName: fiscal.legalName, taxId: fiscal.taxId } : null,
      subscription: sub,
      occupiedSeats,
      /** Plano + assentos avulsos do anual — o que a empresa pode de fato usar. */
      entitledSeats: entitledSeats(sub),
      availableSeats: entitledSeats(sub) - occupiedSeats,
      /** Assinaturas de assentos anuais, cada uma com renovação própria. */
      seatAddons,
      prices: {
        // Preço do PLANO. Os add-ons anuais são cobrados à parte e não entram aqui —
        // somá-los faria um assento anual parecer receita mensal recorrente.
        monthlyCents: monthlyTotalCents(sub.purchasedSeats),
        annualCents: annualTotalCents(sub.purchasedSeats),
        addonAnnualCents: sub.addonSeats * ANNUAL_SEAT_CENTS,
      },
      charges,
    };
  }

  /**
   * Encerra uma assinatura de assentos anual por dentro. É a saída que o cliente não
   * tem no self-service (reduzir assento só existe no mensal): quem precisa cortar um
   * bloco anual passa pelo suporte, e é aqui que a operação faz isso.
   */
  async cancelSeatAddon(companyId: string, addonId: string) {
    const addon = await this.repo.findSeatAddonById(addonId);
    if (!addon || addon.companyId !== companyId) {
      throw new NotFoundException('Assinatura de assentos não encontrada para esta empresa');
    }
    if (addon.status === 'canceled') return this.getCompanyDetail(companyId);

    if (addon.asaasSubscriptionId) {
      try {
        await this.asaas.deleteSubscription(addon.asaasSubscriptionId);
      } catch (err: unknown) {
        this.logger.error(
          { companyId, addonId, asaasSubscriptionId: addon.asaasSubscriptionId, err },
          'Falha ao encerrar assinatura de assentos no Asaas',
        );
      }
    }
    await this.repo.updateSeatAddon(addonId, { status: 'canceled', canceledAt: new Date() });
    await this.repo.syncAddonSeats(addon.subscriptionId, companyId);
    this.access.invalidate(companyId);
    this.logger.warn(
      { companyId, addonId, seats: addon.seats },
      'Superadmin encerrou uma assinatura de assentos adicionais',
    );
    return this.getCompanyDetail(companyId);
  }

  async listWebhooks(query: ListWebhooksQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 30;
    const [data, total] = await this.repo.listWebhookEvents(
      { status: query.status, type: query.type },
      page,
      limit,
    );
    return { data, total, page, limit };
  }

  getWebhookEvent(id: string) {
    return this.repo.findWebhookEventById(id);
  }

  /**
   * Reprocessa um evento manualmente (resgate de `failed`/`dead` sem `psql`).
   * Idempotente: o processamento reusa `markChargePaid` condicional, então
   * reprocessar um evento já aplicado não duplica nada.
   */
  async reprocessWebhook(id: string) {
    const event = await this.repo.findWebhookEventById(id);
    if (!event) throw new NotFoundException('Evento de webhook não encontrado');
    // Zera as tentativas: é um pedido explícito de operação, não uma retentativa.
    await this.webhook.reprocess({
      id: event.id,
      type: event.type,
      payload: event.payload,
      attempts: 0,
    });
    this.logger.info({ webhookEventId: id, type: event.type }, 'Superadmin reprocessou webhook');
    return this.repo.findWebhookEventById(id);
  }

  // ── Gestão ───────────────────────────────────────────────────────────────

  /**
   * Ajusta o total de assentos. **Aumento é cobrado** pelo mesmo caminho do
   * self-service — antes o superadmin entregava assento de graça sem querer, e a
   * empresa ficava usando mais do que pagava (C14). Para conceder de fato, marque
   * `cortesia` com o motivo: a isenção passa a ser uma decisão explícita e registrada.
   */
  async adjustSeats(companyId: string, dto: AdjustSeatsDto) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    const occupied = await this.repo.countOccupiedSeats(companyId);
    if (dto.total < occupied) {
      throw new BadRequestException(
        `Não é possível reduzir para ${dto.total}: há ${occupied} usuário(s) em uso`,
      );
    }

    // `total` é sempre do PLANO. Os assentos avulsos do anual têm assinatura própria e
    // saem por `cancelSeatAddon` — misturá-los aqui deixaria o superadmin "reduzindo"
    // um bloco anual pago sem cancelar a cobrança que o renova.
    const delta = dto.total - sub.purchasedSeats;
    if (delta > 0 && !dto.cortesia) {
      // Cobrado em Pix, valor cheio, pelo mesmo caminho do self-service: o assento só
      // vale quando a empresa pagar.
      const charge = await this.billing.chargeSeatsAdjustedBySuperadmin(
        companyId,
        delta,
        'superadmin',
      );
      this.logger.info(
        { companyId, delta, chargeId: charge?.id ?? null },
        'Superadmin ajustou assentos com cobrança',
      );
      this.access.invalidate(companyId);
      return this.getCompanyDetail(companyId);
    }
    if (delta > 0) {
      if (!dto.motivo?.trim()) {
        throw new BadRequestException('Informe o motivo da cortesia');
      }
      this.logger.warn(
        { companyId, delta, motivo: dto.motivo },
        'Superadmin concedeu assentos SEM cobrança (cortesia)',
      );
    }

    await this.repo.updateSubscription(sub.id, { purchasedSeats: dto.total });
    // O que a empresa paga acompanha os assentos (C4): sem isto o mensal seguiria
    // cobrando o valor antigo para sempre — a menos/mais do que o devido.
    if (sub.method === 'monthly_card' && sub.asaasSubscriptionId) {
      try {
        await this.asaas.updateSubscriptionValue(
          sub.asaasSubscriptionId,
          monthlyValueReais(dto.total),
        );
      } catch (err: unknown) {
        this.logger.error(
          { companyId, asaasSubscriptionId: sub.asaasSubscriptionId, seats: dto.total, err },
          'Assentos ajustados, mas o valor da recorrência no Asaas não foi atualizado',
        );
      }
    }
    this.logger.info({ companyId, total: dto.total }, 'Superadmin ajustou assentos');
    this.access.invalidate(companyId);
    return this.getCompanyDetail(companyId);
  }

  async setCourtesy(companyId: string, dto: CourtesyDto) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    if (dto.grant) {
      await this.cancelAsaasSubscription(sub);
      // Cortesia é isenção total: deixar as assinaturas de assentos anuais cobrando
      // seria cobrar quem acabou de ser isentado.
      await this.billing.cancelarAddonsDaEmpresa(companyId, 'cortesia concedida');
      await this.repo.updateSubscription(sub.id, {
        status: 'courtesy',
        method: null,
        asaasSubscriptionId: null,
        cancelAtPeriodEnd: false,
        superadminLocked: false,
        graceUntil: null,
      });
    } else {
      // Revogar cortesia → somente leitura (a empresa precisa assinar).
      await this.repo.updateSubscription(sub.id, { status: 'readonly' });
    }
    this.logger.info({ companyId, grant: dto.grant }, 'Superadmin alterou cortesia');
    this.access.invalidate(companyId);
    return this.getCompanyDetail(companyId);
  }

  async extendTrial(companyId: string, dto: ExtendTrialDto) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    await this.repo.updateSubscription(sub.id, {
      status: 'trial',
      trialEndsAt: new Date(dto.endsAt),
      superadminLocked: false,
    });
    this.logger.info({ companyId, endsAt: dto.endsAt }, 'Superadmin estendeu trial');
    this.access.invalidate(companyId);
    return this.getCompanyDetail(companyId);
  }

  async cancel(companyId: string, dto: CancelSubscriptionDto) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    if (dto.atPeriodEnd ?? true) {
      await this.repo.updateSubscription(sub.id, { cancelAtPeriodEnd: true });
    } else {
      await this.cancelAsaasSubscription(sub);
      await this.billing.cancelarAddonsDaEmpresa(
        companyId,
        'cancelamento imediato pelo superadmin',
      );
      await this.repo.updateSubscription(sub.id, {
        status: 'canceled',
        canceledAt: new Date(),
        cancelAtPeriodEnd: false,
        asaasSubscriptionId: null,
      });
    }
    this.logger.info({ companyId, atPeriodEnd: dto.atPeriodEnd }, 'Superadmin cancelou assinatura');
    this.access.invalidate(companyId);
    return this.getCompanyDetail(companyId);
  }

  /**
   * Somente-leitura manual: a empresa **continua usando o app** (consulta e apaga),
   * só não cria nem altera. Mexe apenas na trava — o `status` da assinatura segue
   * refletindo a cobrança, senão um cliente em dia ficaria marcado como vencido e
   * teria que ser "curado" depois.
   */
  async setReadonly(companyId: string, dto: SetReadonlyDto) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    await this.repo.updateSubscription(sub.id, { superadminLocked: dto.locked });
    this.logger.info({ companyId, locked: dto.locked }, 'Superadmin alterou somente-leitura');
    this.access.invalidate(companyId);
    return this.getCompanyDetail(companyId);
  }

  /**
   * Suspensão total (R44): fecha a porta da empresa — nem leitura. É para fraude,
   * abuso ou ordem judicial, **não** para inadimplência (essa vira somente-leitura
   * sozinha). Fica separada do `setReadonly` justamente para ninguém tirar o acesso
   * de um cliente achando que está só limitando a edição.
   */
  async suspendAccess(companyId: string, dto: SuspendAccessDto) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    if (dto.suspended && !dto.motivo?.trim()) {
      throw new BadRequestException('Informe o motivo da suspensão');
    }

    await this.repo.updateSubscription(sub.id, { accessSuspended: dto.suspended });
    this.access.invalidate(companyId);
    this.logger.warn(
      { companyId, suspended: dto.suspended, motivo: dto.motivo },
      dto.suspended ? 'Superadmin SUSPENDEU o acesso da empresa' : 'Superadmin devolveu o acesso',
    );
    return this.getCompanyDetail(companyId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getSubscriptionOrThrow(companyId: string): Promise<Subscription> {
    const sub = await this.repo.findSubscriptionByCompany(companyId);
    if (!sub) throw new NotFoundException('Assinatura não encontrada para esta empresa');
    return sub;
  }

  /** Cancela a assinatura recorrente no Asaas (best-effort — não quebra a ação). */
  private async cancelAsaasSubscription(sub: Subscription): Promise<void> {
    if (!sub.asaasSubscriptionId) return;
    try {
      await this.asaas.deleteSubscription(sub.asaasSubscriptionId);
    } catch (err: unknown) {
      this.logger.error(
        { companyId: sub.companyId, asaasSubscriptionId: sub.asaasSubscriptionId, err },
        'Falha ao cancelar assinatura no Asaas',
      );
    }
  }
}
