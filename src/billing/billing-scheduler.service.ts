import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { addHours, differenceInCalendarDays, differenceInHours, subDays } from 'date-fns';
import { rmSync } from 'fs';
import { join } from 'path';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';
import { AsaasClient } from './asaas/asaas.client';
import { BillingAccessService } from './billing-access.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';

const RECONCILE_AGE_HOURS = 6;
/** Dias que os dados de uma empresa cancelada ficam guardados antes da exclusão (R43). */
const RETENCAO_DIAS = 90;
/** Avisos antes da exclusão, em dias que faltam. */
const AVISOS_DE_RETENCAO = [30, 7];
/** Quantos eventos da fila de webhook são reprocessados por rodada. */
const WEBHOOK_DRAIN_LIMIT = 50;
/** Checkouts pagos sem cobrança vinculada, resolvidos por rodada. */
const CHECKOUT_BIND_LIMIT = 25;
/** Idade mínima de um checkout para valer a pena procurar o pagamento dele no Asaas. */
const CHECKOUT_BIND_AFTER_MINUTES = 10;
/** Assinaturas com add-ons reconciliadas por rodada. */
const ADDON_SYNC_LIMIT = 50;
/** Silêncio (horas) a partir do qual suspeitamos de fila interrompida no Asaas. */
const DEFAULT_SILENCE_HOURS = 12;
/** Intervalo mínimo entre dois alertas de silêncio (evita e-mail de hora em hora). */
const SILENCE_ALERT_COOLDOWN_HOURS = 12;

/**
 * Cron de cobrança. NÃO renova o mensal — a assinatura nativa do Asaas faz isso e o
 * webhook processa. Aqui: fim de trial, carência do mensal, vencimento/lembretes do
 * anual, expiração de Pix, cancelamento agendado, conciliação (por cobrança e por
 * assinatura — rede de segurança para webhook perdido, B3) e o alarme de fila
 * interrompida (B9). A cada 5 min, drena a fila de webhooks que falharam (B1).
 * Idempotência de e-mails via `BillingNotice`; transições de status são auto-idempotentes.
 */
@Injectable()
export class BillingSchedulerService {
  private lastSilenceAlertAt: Date | null = null;

  constructor(
    private readonly repo: BillingRepository,
    private readonly mailer: MailerService,
    private readonly access: BillingAccessService,
    private readonly webhook: BillingWebhookService,
    private readonly billing: BillingService,
    private readonly checkout: BillingCheckoutService,
    private readonly asaas: AsaasClient,
    private readonly config: ConfigService,
    private readonly alerts: BillingAlertsService,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(BillingSchedulerService.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') return;
    await this.run(new Date());
  }

  /** Fila de reprocessamento de webhooks — mais frequente que o resto. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async drainTick(): Promise<void> {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') return;
    await this.safe(() => this.drainWebhookQueue(new Date()), 'webhook-drain');
  }

  /** Executável com um `now` fixo para testes. */
  async run(now: Date): Promise<void> {
    await this.safe(() => this.handleTrials(now), 'trials');
    await this.safe(() => this.handleGrace(now), 'grace');
    await this.safe(() => this.handleAnnual(now), 'annual');
    await this.safe(() => this.handleExpiredPix(now), 'expired-pix');
    await this.safe(() => this.handleCancellations(now), 'cancellations');
    await this.safe(() => this.reconcile(now), 'reconcile');
    await this.safe(() => this.reconcileSubscriptions(now), 'reconcile-subscriptions');
    await this.safe(() => this.repairStuckActivations(now), 'repair-stuck');
    await this.safe(() => this.bindPendingCheckouts(now), 'checkout-bind');
    await this.safe(() => this.expireCheckouts(now), 'checkout-expire');
    await this.safe(() => this.handleSeatAddons(now), 'seat-addons');
    await this.safe(() => this.reconcileAddonSeats(), 'addon-seats');
    await this.safe(() => this.handleRetencao(now), 'retencao');
    await this.safe(() => this.checkWebhookSilence(now), 'webhook-silence');
  }

  // ── Fila de webhooks (B1) ───────────────────────────────────────────────────

  /**
   * Reprocessa eventos gravados que ainda não fecharam: `failed` com a hora de
   * retentativa vencida e `received` presos (processo caiu no meio). `reprocess`
   * não lança — ele mesmo reagenda ou declara o evento morto.
   */
  async drainWebhookQueue(now: Date): Promise<void> {
    const events = await this.repo.findRetriableWebhookEvents(now, WEBHOOK_DRAIN_LIMIT);
    if (events.length === 0) return;
    for (const e of events) {
      await this.webhook.reprocess({
        id: e.id,
        type: e.type,
        payload: e.payload,
        attempts: e.attempts,
      });
    }
    this.logger.info({ count: events.length }, 'Fila de webhooks reprocessada');
  }

  // ── Sub-rotinas ─────────────────────────────────────────────────────────────

  /**
   * Liga ao pagamento as cobranças que nasceram de checkout e ficaram sem vínculo.
   *
   * É a rede para o `CHECKOUT_PAID` que não chegou (ou chegou sem o id do pagamento):
   * sem ela, um cliente que pagou no cartão ficaria pendente até clicar em "Já paguei".
   * Espera alguns minutos antes de tentar — o Asaas leva um instante para materializar
   * a cobrança, e procurar cedo demais só gasta chamada.
   */
  private async bindPendingCheckouts(now: Date): Promise<void> {
    const corte = new Date(now.getTime() - CHECKOUT_BIND_AFTER_MINUTES * 60_000);
    const pendentes = await this.repo.findUnboundCheckoutCharges(corte, CHECKOUT_BIND_LIMIT);
    let ligadas = 0;
    for (const charge of pendentes) {
      const sub = await this.repo.findSubscriptionById(charge.subscriptionId);
      if (!sub) continue;
      const payment = await this.checkout.casarPagamento(charge, sub);
      if (!payment) continue;
      await this.repo.updateCharge(charge.id, {
        asaasPaymentId: payment.id,
        invoiceUrl: payment.invoiceUrl,
      });
      await this.webhook.reconcilePayment(payment.id, 'cron_charge');
      ligadas += 1;
    }
    if (ligadas > 0) {
      this.logger.info({ ligadas }, 'Cobranças de checkout ligadas ao pagamento do Asaas');
    }
  }

  /**
   * Encerra os checkouts que passaram da validade sem pagamento. Enquanto a cobrança
   * fica `pending`, o intento segue travado pelo índice único — expirar é o que
   * devolve ao cliente a possibilidade de tentar de novo.
   */
  private async expireCheckouts(now: Date): Promise<void> {
    const vencidos = await this.repo.findExpiredCheckoutCharges(now);
    for (const charge of vencidos) {
      if (charge.asaasCheckoutId) {
        try {
          await this.asaas.cancelCheckout(charge.asaasCheckoutId);
        } catch (err: unknown) {
          this.logger.warn(
            { chargeId: charge.id, checkoutId: charge.asaasCheckoutId, err },
            'Falha ao cancelar checkout expirado no Asaas',
          );
        }
      }
      await this.repo.updateCharge(charge.id, {
        status: 'expired',
        checkoutUrl: null,
        checkoutExpiresAt: null,
      });
      // Assinatura de assentos criada para uma compra abandonada não pode sobreviver.
      await this.billing.descartarAddonPendente(charge);
    }
    if (vencidos.length > 0) {
      this.logger.info({ count: vencidos.length }, 'Checkouts expirados encerrados');
    }
  }

  /**
   * Assinaturas de assentos anuais que não foram renovadas e esgotaram a carência
   * deixam de valer. Ninguém é expulso: os assentos somem do total e o
   * `assertSeatAvailable` passa a barrar entradas novas — tirar gente que está
   * trabalhando por uma cobrança atrasada seria desproporcional.
   */
  private async handleSeatAddons(now: Date): Promise<void> {
    const vencidos = await this.repo.findSeatAddonsPastGrace(now);
    for (const addon of vencidos) {
      if (addon.asaasSubscriptionId) {
        try {
          await this.asaas.deleteSubscription(addon.asaasSubscriptionId);
        } catch (err: unknown) {
          this.logger.warn(
            { addonId: addon.id, err },
            'Falha ao encerrar assinatura de assentos vencida no Asaas',
          );
        }
      }
      await this.repo.updateSeatAddon(addon.id, { status: 'canceled', canceledAt: now });
      await this.repo.syncAddonSeats(addon.subscriptionId, addon.companyId);
      this.access.invalidate(addon.companyId);
      this.logger.warn(
        { companyId: addon.companyId, addonId: addon.id, seats: addon.seats },
        'Assentos adicionais encerrados por falta de pagamento',
      );
    }
  }

  /**
   * Reconcilia o contador `addonSeats` com a tabela. O contador é desnormalizado para
   * não pesar o caminho quente de contratar membro; esta varredura é o que impede a
   * divergência de virar assento fantasma (ou assento perdido).
   */
  private async reconcileAddonSeats(): Promise<void> {
    const comAddons = await this.repo.findSubscriptionsWithAddons(ADDON_SYNC_LIMIT);
    for (const sub of comAddons) {
      const real = await this.repo.sumActiveAddonSeats(sub.companyId);
      if (real === sub.addonSeats) continue;
      await this.repo.syncAddonSeats(sub.id, sub.companyId);
      this.access.invalidate(sub.companyId);
      this.logger.warn(
        { companyId: sub.companyId, antes: sub.addonSeats, depois: real },
        'Contador de assentos adicionais corrigido',
      );
    }
  }

  private async handleTrials(now: Date): Promise<void> {
    for (const t of await this.repo.findTrials()) {
      if (!t.trialEndsAt) continue;
      if (t.trialEndsAt < now) {
        await this.toReadOnly(t.id, t.companyId);
        await this.notify(t.id, 'trial_ended', t.trialEndsAt, t.companyId, (to) =>
          this.mailer.sendTrialEndedEmail(to, t.companyId),
        );
      } else {
        const days = differenceInCalendarDays(t.trialEndsAt, now);
        if (days === 3 || days === 1) {
          await this.notify(t.id, `trial_d${days}`, t.trialEndsAt, t.companyId, (to) =>
            this.mailer.sendTrialEndingEmail(to, t.companyId, days),
          );
        }
      }
    }
  }

  private async handleGrace(now: Date): Promise<void> {
    for (const s of await this.repo.findPastDue()) {
      if (s.graceUntil && s.graceUntil < now) {
        await this.toReadOnly(s.id, s.companyId);
        await this.notify(s.id, 'readonly', s.graceUntil, s.companyId, (to) =>
          this.mailer.sendReadOnlyActivatedEmail(to, s.companyId),
        );
      }
    }
  }

  /**
   * Vencimento e lembretes do anual **no cartão** — o único que ainda não renova
   * sozinho (o Asaas não combina assinatura recorrente com parcelamento, e o
   * parcelado em 12× é o que faz o anual vender).
   *
   * O anual no Pix virou assinatura nativa: o Asaas gera a cobrança do ano seguinte e
   * o não pagamento chega como `PAYMENT_OVERDUE`, com carência, igual ao mensal.
   */
  private async handleAnnual(now: Date): Promise<void> {
    for (const s of await this.repo.findActiveAnnual()) {
      if (!s.currentPeriodEnd) continue;
      if (s.currentPeriodEnd < now) {
        await this.toReadOnly(s.id, s.companyId);
        await this.notify(s.id, 'readonly', s.currentPeriodEnd, s.companyId, (to) =>
          this.mailer.sendReadOnlyActivatedEmail(to, s.companyId),
        );
      } else {
        const days = differenceInCalendarDays(s.currentPeriodEnd, now);
        if (days === 15 || days === 7 || days === 1) {
          await this.notify(s.id, `annual_d${days}`, s.currentPeriodEnd, s.companyId, (to) =>
            this.mailer.sendAnnualRenewalReminderEmail(to, s.companyId, days),
          );
        }
      }
    }
  }

  private async handleExpiredPix(now: Date): Promise<void> {
    const expired = await this.repo.findExpiredPixCharges(now);
    for (const c of expired) {
      await this.repo.updateCharge(c.id, { status: 'expired' });
    }
    if (expired.length) this.logger.info({ count: expired.length }, 'Expired pending Pix charges');
  }

  private async handleCancellations(now: Date): Promise<void> {
    for (const s of await this.repo.findCancelDue(now)) {
      // Encerra a recorrência no Asaas ao efetivar o cancelamento. Cobre o caminho do
      // superadmin (que mantém o `asaasSubscriptionId` até aqui); no cancelamento
      // self-service do mensal o id já foi zerado no ato, então isto é no-op.
      if (s.asaasSubscriptionId) {
        try {
          await this.asaas.deleteSubscription(s.asaasSubscriptionId);
        } catch (err: unknown) {
          this.logger.error(
            { companyId: s.companyId, asaasSubscriptionId: s.asaasSubscriptionId, err },
            'Falha ao encerrar assinatura no Asaas ao cancelar no fim do ciclo',
          );
        }
      }
      // As assinaturas de assentos anuais renovariam sozinhas depois do cancelamento —
      // o cliente cancelaria o plano e continuaria sendo cobrado por elas todo ano.
      await this.billing.cancelarAddonsDaEmpresa(s.companyId, 'cancelamento efetivado');
      await this.repo.updateSubscription(s.id, {
        status: 'canceled',
        canceledAt: now,
        asaasSubscriptionId: null,
        // Cancelamento consumido: a flag não pode sobreviver para o próximo plano (C1).
        cancelAtPeriodEnd: false,
      });
      this.access.invalidate(s.companyId);
      this.logger.info({ companyId: s.companyId }, 'Subscription canceled at period end');
    }
  }

  private async reconcile(now: Date): Promise<void> {
    const cutoff = addHours(now, -RECONCILE_AGE_HOURS);
    for (const c of await this.repo.findStalePendingCharges(cutoff)) {
      if (!c.asaasPaymentId) continue;
      try {
        await this.webhook.reconcilePayment(c.asaasPaymentId, 'cron_charge');
      } catch (err: unknown) {
        this.logger.warn({ chargeId: c.id, err }, 'Reconcile of stale charge failed');
      }
    }
  }

  /**
   * Confere no Asaas as cobranças das assinaturas recorrentes (B3). É o único
   * caminho que enxerga a renovação mensal quando o webhook não chega: sem isso,
   * quem pagou pode ficar bloqueado e quem não pagou seguiria ativo para sempre.
   */
  private async reconcileSubscriptions(now: Date): Promise<void> {
    const cutoff = addHours(now, 24); // ciclo vencido ou vencendo nas próximas 24h
    for (const s of await this.repo.findSubscriptionsNeedingSync(cutoff)) {
      if (!s.asaasSubscriptionId) continue;
      try {
        await this.webhook.reconcileSubscription(s.asaasSubscriptionId);
      } catch (err: unknown) {
        this.logger.warn(
          { companyId: s.companyId, asaasSubscriptionId: s.asaasSubscriptionId, err },
          'Reconcile da assinatura falhou',
        );
      }
    }
  }

  /**
   * Varre empresas que pagaram mas ficaram bloqueadas por uma ativação interrompida
   * (B18) — cobre quem não abre a tela de cobrança para disparar a cura sob demanda.
   */
  private async repairStuckActivations(now: Date): Promise<void> {
    for (const s of await this.repo.findStuckSubscriptions(now)) {
      try {
        await this.webhook.repairStuckActivation(s.companyId, now);
      } catch (err: unknown) {
        this.logger.warn({ companyId: s.companyId, err }, 'Falha ao curar ativação interrompida');
      }
    }
  }

  /**
   * Régua de retenção (R43): empresa cancelada é avisada em D-30 e D-7 e, passados
   * 90 dias, tem os dados excluídos. Guardar acervo de quem não é mais cliente é
   * custo e exposição — mas exclusão não tem "desfazer", então só roda com a env
   * ligada e tem modo de ensaio.
   */
  private async handleRetencao(now: Date): Promise<void> {
    if (this.config.get<string>('BILLING_RETENTION_ENABLED') !== 'true') return;
    const ensaio = this.config.get<string>('BILLING_RETENTION_DRY_RUN') === 'true';

    // Avisos: cancelou há (90 - N) dias.
    for (const faltam of AVISOS_DE_RETENCAO) {
      const alvo = subDays(now, RETENCAO_DIAS - faltam);
      for (const s of await this.repo.findCanceledSince(alvo, 100)) {
        if (!s.canceledAt) continue;
        const diasDesdeCancelamento = differenceInCalendarDays(now, s.canceledAt);
        if (diasDesdeCancelamento !== RETENCAO_DIAS - faltam) continue;
        await this.notify(s.id, `retention_d${faltam}`, s.canceledAt, s.companyId, (to) =>
          this.mailer.sendDataRetentionWarningEmail(to, s.companyId, faltam),
        );
      }
    }

    // Exclusão: cancelou há 90 dias ou mais.
    const corte = subDays(now, RETENCAO_DIAS);
    for (const s of await this.repo.findCanceledSince(corte)) {
      if (ensaio) {
        this.logger.warn(
          { companyId: s.companyId, canceledAt: s.canceledAt, ensaio: true },
          'Retenção (ensaio): esta empresa seria excluída agora',
        );
        continue;
      }
      const { taskIds } = await this.repo.purgeCompanyData(s.companyId, now);
      this.removerAnexosDoDisco(taskIds, s.companyId);
      this.access.invalidate(s.companyId);
      await this.alerts.raise('data_retention_purged', {
        companyId: s.companyId,
        canceledAt: s.canceledAt?.toISOString() ?? null,
        tasksRemovidas: taskIds.length,
      });
    }
  }

  /** Remove os diretórios de anexo das tasks apagadas (`uploads/attachments/<taskId>`). */
  private removerAnexosDoDisco(taskIds: string[], companyId: string): void {
    for (const taskId of taskIds) {
      const dir = join(process.cwd(), 'uploads', 'attachments', taskId);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err: unknown) {
        this.logger.error({ companyId, taskId, err }, 'Falha ao remover anexos do disco');
      }
    }
  }

  /**
   * Alarme de fila interrompida (B9): o Asaas para de entregar após 15 falhas
   * seguidas e só volta com reativação manual — e os eventos expiram em 14 dias.
   * Silêncio prolongado havendo assinatura viva é sinal forte disso.
   */
  private async checkWebhookSilence(now: Date): Promise<void> {
    const last = await this.repo.findLastWebhookEventAt();
    if (last) {
      this.metrics.billingLastWebhookAge(Math.max(0, (now.getTime() - last.getTime()) / 1000));
    }

    const configured = Number(this.config.get<string>('BILLING_WEBHOOK_SILENCE_HOURS'));
    const limitHours =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SILENCE_HOURS;
    const silentHours = last ? differenceInHours(now, last) : Number.POSITIVE_INFINITY;
    if (silentHours < limitHours) return;

    // Só faz sentido alarmar se existe cobrança viva para gerar eventos.
    if ((await this.repo.countLiveSubscriptions()) === 0) return;

    if (
      this.lastSilenceAlertAt &&
      differenceInHours(now, this.lastSilenceAlertAt) < SILENCE_ALERT_COOLDOWN_HOURS
    ) {
      return;
    }
    this.lastSilenceAlertAt = now;
    await this.alerts.raise('webhook_silence', {
      ultimoEvento: last?.toISOString() ?? 'nenhum',
      horasSemEvento: Number.isFinite(silentHours) ? silentHours : 'sempre',
      acao: 'Verificar a fila em Minha Conta > Integrações no Asaas (eventos expiram em 14 dias)',
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async toReadOnly(subscriptionId: string, companyId: string): Promise<void> {
    await this.repo.updateSubscription(subscriptionId, { status: 'readonly' });
    this.access.invalidate(companyId);
  }

  /** Envia um e-mail aos admins uma única vez por (assinatura, tipo, vencimento). */
  private async notify(
    subscriptionId: string,
    kind: string,
    anchorAt: Date,
    companyId: string,
    send: (to: string[]) => Promise<void>,
  ): Promise<void> {
    try {
      await this.repo.createNotice({ subscriptionId, kind, anchorAt });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return; // já enviado
      throw err;
    }
    const emails = await this.repo.findCompanyAdminEmails(companyId);
    await send(emails);
  }

  private async safe(fn: () => Promise<void>, label: string): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      this.logger.error({ err, step: label }, 'Billing scheduler step failed');
    }
  }
}
