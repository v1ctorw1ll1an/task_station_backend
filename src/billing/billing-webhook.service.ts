import { Injectable } from '@nestjs/common';
import { addDays, addMinutes, addMonths, addYears } from 'date-fns';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type {
  BillingCharge,
  ChargeType,
  PaymentKind,
  SeatAddon,
  Subscription,
} from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';
import { AsaasClient } from './asaas/asaas.client';
import type { AsaasCheckout, AsaasPayment, AsaasWebhookPayload } from './asaas/asaas.types';
import { BillingAccessService } from './billing-access.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingRepository } from './billing.repository';
import { GRACE_DAYS } from './billing.constants';
import { monthlyValueReais } from './pricing';

const PAID_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH']);
/** Eventos do checkout hospedado. `CHECKOUT_CREATED` não interessa (nós o criamos). */
const CHECKOUT_EVENTS = new Set(['CHECKOUT_PAID', 'CHECKOUT_EXPIRED', 'CHECKOUT_CANCELED']);
const PAID_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);
const REVERSED_EVENTS = new Set([
  'PAYMENT_REFUNDED',
  'PAYMENT_DELETED',
  'PAYMENT_REVERSED',
  'PAYMENT_CHARGEBACK_REQUESTED',
]);

/** Espera entre tentativas de reprocessamento (minutos): 1m, 5m, 15m, 1h, 6h, 24h. */
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 360, 1440];
const MAX_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1;
/** Se o processo morrer no meio, o evento fica `received`; o cron o retoma após isso. */
const STUCK_AFTER_MINUTES = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Desfecho da **gravação** do evento — decide o status HTTP devolvido ao Asaas. */
export type WebhookIngestResult = 'ok' | 'duplicate' | 'invalid' | 'persist_failed';

/** Origem de uma conciliação (rótulo de métrica). */
export type ReconcileSource = 'status' | 'cron_charge' | 'cron_subscription';

/**
 * Processa webhooks do Asaas. O estado da assinatura é definido AQUI (R27), não na
 * resposta do checkout.
 *
 * Garantias (docs/cobranca-auditoria.md):
 * - **Inbox durável (B1):** o evento é gravado ANTES de processar. Se não der para
 *   gravar, o controller devolve erro e o Asaas reentrega (a fila dele guarda 14
 *   dias). Gravado, o processamento pode falhar à vontade: fica `failed` com
 *   `nextAttemptAt` e o cron reprocessa com backoff; esgotado, vira `dead` + alerta.
 * - **Idempotência:** unique em `asaasEventId` + `markChargePaid` condicional.
 * - Nunca confia no payload: re-busca o pagamento no Asaas.
 */
@Injectable()
export class BillingWebhookService {
  constructor(
    private readonly repo: BillingRepository,
    private readonly asaas: AsaasClient,
    private readonly access: BillingAccessService,
    private readonly checkout: BillingCheckoutService,
    private readonly mailer: MailerService,
    private readonly alerts: BillingAlertsService,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(BillingWebhookService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Entrada ────────────────────────────────────────────────────────────────

  /**
   * Grava o evento (inbox) e tenta processá-lo na hora. O retorno diz ao controller
   * se pode confirmar (200) ou se precisa pedir reentrega (5xx).
   */
  async handle(payload: AsaasWebhookPayload): Promise<WebhookIngestResult> {
    const eventId = payload.id;
    const event = payload.event;
    if (!eventId || !event) {
      this.logger.warn({ payload }, 'Webhook malformado (sem id/event) — ignorado');
      this.metrics.billingWebhook(event ?? 'unknown', 'invalid');
      return 'invalid';
    }

    let record: { id: string };
    try {
      record = await this.repo.createWebhookEvent({
        asaasEventId: eventId,
        type: event,
        asaasPaymentId: payload.payment?.id,
        asaasCheckoutId: payload.checkout?.id,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: 'received',
        attempts: 0,
        // Se este processo morrer antes de concluir, o cron retoma a partir daqui.
        nextAttemptAt: addMinutes(new Date(), STUCK_AFTER_MINUTES),
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.debug({ eventId, event }, 'Webhook duplicado — no-op');
        this.metrics.billingWebhook(event, 'duplicate');
        return 'duplicate';
      }
      // NÃO confirmar: sem o evento gravado, confirmar seria perdê-lo para sempre.
      this.logger.error({ eventId, event, err }, 'Falha ao gravar webhook — pedindo reentrega');
      this.metrics.billingWebhook(event, 'persist_failed');
      return 'persist_failed';
    }

    this.metrics.billingWebhook(event, 'received');
    await this.runEvent(record.id, event, payload, 0);
    return 'ok';
  }

  /** Reprocessa um evento já gravado (fila do cron / botão do superadmin). */
  async reprocess(record: {
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
  }): Promise<void> {
    const payload = (record.payload ?? {}) as AsaasWebhookPayload;
    await this.runEvent(record.id, record.type, payload, record.attempts);
  }

  private async runEvent(
    id: string,
    event: string,
    payload: AsaasWebhookPayload,
    attempts: number,
  ): Promise<void> {
    try {
      const outcome = await this.process(event, payload);
      await this.repo.markWebhookProcessed(id, outcome);
      this.metrics.billingWebhook(event, outcome);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.scheduleRetry(id, event, attempts, message);
    }
  }

  /** Agenda a próxima tentativa (backoff) ou declara o evento morto. */
  private async scheduleRetry(
    id: string,
    event: string,
    attempts: number,
    message: string,
  ): Promise<void> {
    const next = attempts + 1;
    try {
      if (next >= MAX_ATTEMPTS) {
        await this.repo.markWebhookDead(id, next, message);
        this.metrics.billingWebhook(event, 'dead');
        await this.alerts.raise('webhook_dead', {
          webhookEventId: id,
          event,
          attempts: next,
          error: message,
        });
        return;
      }
      const delay = RETRY_BACKOFF_MINUTES[next - 1] ?? RETRY_BACKOFF_MINUTES[0];
      await this.repo.scheduleWebhookRetry(id, next, addMinutes(new Date(), delay), message);
      this.metrics.billingWebhook(event, 'retry');
      this.logger.warn(
        { webhookEventId: id, event, attempts: next, retryInMinutes: delay, error: message },
        'Falha ao processar webhook — reprocesso agendado',
      );
    } catch (err: unknown) {
      // Nem agendar deu (banco fora): o evento segue `received` com o `nextAttemptAt`
      // definido na gravação, então o cron o retoma mesmo assim.
      this.logger.error({ webhookEventId: id, event, err }, 'Falha ao agendar reprocesso');
    }
  }

  // ── Conciliação (independente de webhook) ──────────────────────────────────

  /**
   * Concilia um pagamento pelo status atual no Asaas — rede de segurança para
   * webhook perdido/atrasado. Reusa a mesma lógica de ativação/estorno (tudo
   * corrida-safe via `markChargePaid`). Devolve `true` se houve o que aplicar.
   */
  async reconcilePayment(paymentId: string, source: ReconcileSource = 'status'): Promise<boolean> {
    const fresh = await this.asaas.getPayment(paymentId);
    if (PAID_STATUSES.has(fresh.status)) {
      await this.onPaid(fresh);
      this.metrics.billingReconcile(source);
      return true;
    }
    if (fresh.status === 'REFUNDED' || fresh.status === 'PAYMENT_DELETED') {
      await this.onReversed(fresh);
      this.metrics.billingReconcile(source);
      return true;
    }
    return false;
  }

  /**
   * Cura de ativação interrompida (B18): cobrança **paga** cujo período cobre hoje,
   * mas assinatura sem ciclo ativo. Acontece quando o processo morre (ou o banco
   * oscila) entre `markChargePaid` e `activate` — e o estado é definitivo, porque
   * `markChargePaid` nunca mais devolve `count > 0` para aquela cobrança e a
   * conciliação só olha cobranças pendentes. Sem isto, o cliente paga e fica
   * bloqueado para sempre.
   *
   * Convergente e segura: usa o período **da própria cobrança** (não estende nada),
   * ignora assinatura travada pelo superadmin e nunca mexe em assentos (proração
   * paga não é reaplicada — não há como saber se já valeu).
   */
  async repairStuckActivation(companyId: string, now: Date = new Date()): Promise<boolean> {
    const sub = await this.repo.findSubscriptionByCompany(companyId);
    if (!sub) return false;
    if (sub.status === 'active' || sub.status === 'courtesy' || sub.status === 'canceled') {
      return false;
    }
    // Atenção: NÃO desista quando o ciclo está em dia. "Ciclo válido + status
    // bloqueado" é justamente a inconsistência a curar — foi o que deixou uma
    // empresa com o anual pago até 2027 presa em `readonly` (C17).

    const charge = await this.repo.findLatestPaidCoveringCharge(companyId, now);
    if (!charge?.periodEnd) return false;

    // Trava manual vence o pagamento (é decisão do superadmin), mas cliente em dia e
    // bloqueado não pode ser um estado silencioso: alguém precisa olhar (C13).
    if (sub.superadminLocked) {
      await this.alerts.raise('payment_blocked_by_lock', {
        companyId,
        chargeId: charge.id,
        cobertoAte: charge.periodEnd.toISOString(),
        status: sub.status,
      });
      return false;
    }

    await this.repo.updateSubscription(sub.id, {
      status: 'active',
      graceUntil: null,
      currentPeriodStart: charge.periodStart ?? charge.paidAt ?? now,
      currentPeriodEnd: charge.periodEnd,
      ...(sub.seatsAtNextRenewal != null
        ? { purchasedSeats: sub.seatsAtNextRenewal, seatsAtNextRenewal: null }
        : {}),
    });
    this.access.invalidate(companyId);
    this.logger.warn(
      { companyId, chargeId: charge.id, statusAnterior: sub.status },
      'Ativação interrompida detectada e corrigida (cobrança paga sem ciclo ativo)',
    );
    return true;
  }

  /**
   * Concilia uma assinatura recorrente lendo as cobranças dela no Asaas (B3). É o
   * único caminho que enxerga a **renovação mensal**, cuja cobrança é criada pelo
   * Asaas e só vira `BillingCharge` local quando processada.
   */
  async reconcileSubscription(asaasSubscriptionId: string): Promise<void> {
    const list = await this.asaas.listSubscriptionPayments(asaasSubscriptionId);
    for (const payment of list.data ?? []) {
      if (PAID_STATUSES.has(payment.status)) {
        await this.onPaid(payment);
        this.metrics.billingReconcile('cron_subscription');
      } else if (payment.status === 'OVERDUE') {
        await this.onOverdue(payment);
        this.metrics.billingReconcile('cron_subscription');
      }
    }
  }

  // ── Processamento ──────────────────────────────────────────────────────────

  private async process(
    event: string,
    payload: AsaasWebhookPayload,
  ): Promise<'processed' | 'ignored'> {
    if (CHECKOUT_EVENTS.has(event)) {
      return this.processCheckout(event, payload.checkout);
    }

    const payment = payload.payment;
    if (!payment?.id) {
      this.logger.warn({ event }, 'Webhook sem payment.id — ignorado');
      return 'ignored';
    }

    // Nunca confiar no payload: re-buscar o status real no Asaas.
    const fresh = await this.asaas.getPayment(payment.id);

    if (PAID_EVENTS.has(event)) {
      if (PAID_STATUSES.has(fresh.status)) {
        await this.onPaid(fresh);
        return 'processed';
      }
      this.logger.warn(
        { paymentId: fresh.id, status: fresh.status },
        'Evento de pago mas status divergente — ignorado',
      );
      return 'ignored';
    }

    if (event === 'PAYMENT_OVERDUE') {
      if (fresh.status === 'OVERDUE') {
        await this.onOverdue(fresh);
        return 'processed';
      }
      return 'ignored';
    }

    if (REVERSED_EVENTS.has(event)) {
      await this.onReversed(fresh);
      return 'processed';
    }

    this.logger.debug({ event }, 'Evento de webhook não tratado — ignorado');
    return 'ignored';
  }

  /**
   * Eventos do checkout hospedado.
   *
   * `CHECKOUT_PAID` **não** é prova de pagamento: a invariante do módulo é que dinheiro
   * só vira estado depois de um GET no Asaas. O que fazemos aqui é achar a cobrança
   * pelo id do checkout, descobrir o pagamento/assinatura que ele criou e entregar ao
   * `onPaid` de sempre. Não conseguiu resolver → **lança**, para o evento voltar pela
   * fila de retry (o Asaas pode levar alguns segundos para materializar a cobrança).
   */
  private async processCheckout(
    event: string,
    checkout: AsaasCheckout | undefined,
  ): Promise<'processed' | 'ignored'> {
    if (!checkout?.id) {
      this.logger.warn({ event }, 'Webhook de checkout sem id — ignorado');
      return 'ignored';
    }
    const charge = await this.repo.findChargeByCheckoutId(checkout.id);
    if (!charge) {
      this.logger.warn({ event, checkoutId: checkout.id }, 'Checkout sem cobrança local');
      return 'ignored';
    }

    if (event === 'CHECKOUT_EXPIRED' || event === 'CHECKOUT_CANCELED') {
      if (charge.status !== 'pending') return 'ignored';
      await this.repo.updateCharge(charge.id, {
        status: event === 'CHECKOUT_EXPIRED' ? 'expired' : 'canceled',
        checkoutUrl: null,
        checkoutExpiresAt: null,
      });
      this.logger.info(
        { chargeId: charge.id, companyId: charge.companyId, event },
        'Checkout encerrado sem pagamento — intento liberado',
      );
      return 'processed';
    }

    if (event !== 'CHECKOUT_PAID') return 'ignored';

    const payment = await this.resolvePagamentoDoCheckout(charge, checkout);
    if (!payment) {
      // Deixa o retry acontecer: o pagamento costuma aparecer segundos depois.
      throw new Error(`Checkout ${checkout.id} pago sem cobrança correspondente no Asaas`);
    }
    await this.onPaid(payment);
    return 'processed';
  }

  /**
   * Acha, para um checkout pago, a cobrança que ele gerou no Asaas. Tenta o que o
   * próprio evento trouxer (quando traz) e cai na busca por cliente/valor do
   * `BillingCheckoutService`, que se recusa a adivinhar em caso de empate.
   */
  private async resolvePagamentoDoCheckout(
    charge: BillingCharge,
    checkout: AsaasCheckout,
  ): Promise<AsaasPayment | null> {
    if (checkout.payment) {
      try {
        return await this.asaas.getPayment(checkout.payment);
      } catch (err: unknown) {
        this.logger.warn(
          { chargeId: charge.id, paymentId: checkout.payment, err },
          'Pagamento indicado pelo checkout não pôde ser lido',
        );
      }
    }
    const sub = await this.repo.findSubscriptionById(charge.subscriptionId);
    if (!sub) return null;
    return this.checkout.casarPagamento(charge, sub);
  }

  private async onPaid(payment: AsaasPayment): Promise<void> {
    let charge = await this.findChargeForPayment(payment);
    if (!charge) {
      // Pagamento gerado pela assinatura nativa (mensal): cria a cobrança agora.
      const sub = await this.resolveSubscription(payment);
      charge = sub ? await this.chargeForSubscriptionPayment(payment, sub) : null;
    }
    if (!charge) {
      await this.alerts.raise('payment_unmatched', {
        paymentId: payment.id,
        value: payment.value,
        externalReference: payment.externalReference ?? null,
        subscription: payment.subscription ?? null,
      });
      return;
    }

    const updated = await this.repo.markChargePaid(charge.id);
    if (updated.count === 0) {
      this.logger.debug({ chargeId: charge.id }, 'Cobrança já estava paga — no-op');
      return;
    }

    if (charge.type === 'seat') {
      // Assento pago passa a valer agora. Não renova o ciclo do plano.
      await this.applyPaidSeats(charge, payment);
    } else {
      // Checkout recorrente: a assinatura nasceu do lado do Asaas e este é o momento
      // de descobrir o id dela — sem isso não há como reajustar valor nem cancelar.
      await this.vincularAssinaturaDoPagamento(charge, payment);
      await this.activate(charge.subscriptionId);
    }

    // Reativação imediata (R24): invalida o cache do gate de escrita.
    this.access.invalidate(charge.companyId);
    this.logger.info(
      { chargeId: charge.id, companyId: charge.companyId, type: charge.type },
      'Pagamento confirmado',
    );
    await this.notifyPaymentConfirmed(charge.companyId, charge.amountCents);
  }

  /**
   * Cadeia de resolução cobrança↔pagamento (B4): id do pagamento →
   * `externalReference` (= id da cobrança, religando o `asaasPaymentId` que faltou
   * quando o processo caiu entre criar no Asaas e gravar aqui) → **checkout aberto do
   * mesmo cliente**.
   *
   * O último passo é o que o checkout hospedado obrigou a existir: o pagamento nasce do
   * lado do Asaas e a documentação não garante que o `externalReference` chegue nele.
   * Sem ele, o pagamento não casaria com a cobrança pendente e o `onPaid` criaria uma
   * SEGUNDA cobrança — a original ficaria pendente para sempre, travando o intento.
   */
  private async findChargeForPayment(payment: AsaasPayment): Promise<BillingCharge | null> {
    const byPaymentId = await this.repo.findChargeByAsaasPaymentId(payment.id);
    if (byPaymentId) return byPaymentId;

    const ref = payment.externalReference;
    if (ref && UUID_RE.test(ref)) {
      const byRef = await this.repo.findChargeById(ref);
      if (byRef) return this.religar(byRef, payment, 'externalReference');
    }

    return this.chargeDoCheckoutAberto(payment);
  }

  /**
   * Cobrança de checkout ainda pendente que corresponde a este pagamento. Exige
   * cliente **e** valor batendo: casar só por cliente confundiria a mensalidade com a
   * compra de assentos de uma empresa que fez as duas coisas na mesma hora.
   */
  private async chargeDoCheckoutAberto(payment: AsaasPayment): Promise<BillingCharge | null> {
    if (!payment.customer) return null;
    const sub = await this.repo.findSubscriptionByAsaasCustomerId(payment.customer);
    if (!sub) return null;

    const cents = Math.round((payment.value ?? 0) * 100);
    for (const type of ['subscription', 'seat'] as const) {
      const aberta = await this.repo.findOpenChargeByIntent(sub.id, type);
      if (aberta?.asaasCheckoutId && !aberta.asaasPaymentId && aberta.amountCents === cents) {
        return this.religar(aberta, payment, 'checkout');
      }
    }
    return null;
  }

  private async religar(
    charge: BillingCharge,
    payment: AsaasPayment,
    via: string,
  ): Promise<BillingCharge> {
    if (charge.asaasPaymentId) {
      // Ids diferentes com o mesmo `externalReference` = parcelas 2…12 do anual-cartão:
      // o pedido é o mesmo, a cobrança local já existe (e já estará paga).
      return charge;
    }
    this.logger.info(
      { chargeId: charge.id, paymentId: payment.id, via },
      'Cobrança ligada ao pagamento do Asaas',
    );
    return this.repo.updateCharge(charge.id, {
      asaasPaymentId: payment.id,
      invoiceUrl: payment.invoiceUrl ?? charge.invoiceUrl,
    });
  }

  private async resolveSubscription(payment: AsaasPayment): Promise<Subscription | null> {
    if (payment.subscription) {
      const bySub = await this.repo.findSubscriptionByAsaasSubscriptionId(payment.subscription);
      if (bySub) return bySub;
      // Pode ser a renovação de uma assinatura de assentos anual — cobrança própria,
      // empresa a mesma.
      const addon = await this.repo.findSeatAddonByAsaasSubscription(payment.subscription);
      if (addon) return this.repo.findSubscriptionById(addon.subscriptionId);
    }
    const ref = payment.externalReference;
    if (ref && UUID_RE.test(ref)) {
      // `createSubscription` usa `externalReference = subscription.id` (plano) ou
      // `= seatAddon.id` (assentos anuais).
      const byRef = await this.repo.findSubscriptionById(ref);
      if (byRef) return byRef;
      const addon = await this.repo.findSeatAddonById(ref);
      if (addon) return this.repo.findSubscriptionById(addon.subscriptionId);
    }
    return null;
  }

  private async chargeForSubscriptionPayment(
    payment: AsaasPayment,
    sub: Subscription,
  ): Promise<BillingCharge | null> {
    const now = new Date();
    // Renovação de assinatura de assentos: cobrança própria, tipo próprio, e NÃO
    // renova o ciclo do plano — o `onPaid` a trata como assento, não como plano.
    const addon = await this.addonDoPagamento(payment);
    if (addon) {
      return this.repo.createCharge({
        subscriptionId: sub.id,
        companyId: sub.companyId,
        seatAddonId: addon.id,
        type: 'seat',
        paymentKind: addon.paymentKind,
        status: 'pending',
        amountCents: Math.round((payment.value ?? 0) * 100),
        installments: 1,
        seats: sub.purchasedSeats + sub.addonSeats,
        seatsDelta: null,
        periodStart: now,
        periodEnd: addYears(now, 1),
        asaasPaymentId: payment.id,
        metadata: { method: sub.method, origem: 'renovacao_assentos' },
      });
    }

    const type: ChargeType = sub.currentPeriodStart ? 'renewal' : 'subscription';
    const isAnnual = sub.method === 'annual_pix' || sub.method === 'annual_card';
    const data = {
      subscriptionId: sub.id,
      companyId: sub.companyId,
      type,
      paymentKind: (sub.method === 'annual_pix' ? 'pix' : 'credit_card') as PaymentKind,
      status: 'pending' as const,
      amountCents: Math.round((payment.value ?? 0) * 100),
      installments: 1,
      seats: sub.purchasedSeats,
      periodStart: now,
      periodEnd: isAnnual ? addYears(now, 1) : addMonths(now, 1),
      asaasPaymentId: payment.id,
      // Sem o método gravado, o checkout trataria esta cobrança como "de outro
      // plano" e a cancelaria no Asaas — apagando uma cobrança legítima da
      // recorrência (C5).
      metadata: sub.method ? { method: sub.method } : undefined,
    };

    try {
      return await this.repo.createCharge(data);
    } catch (err: unknown) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      // Já existia uma cobrança aberta do mesmo intento (índice único parcial) ou
      // outra execução criou a deste pagamento: adota em vez de duplicar.
      const open = await this.repo.findOpenChargeByIntent(sub.id, type);
      if (open && !open.asaasPaymentId) {
        return this.repo.updateCharge(open.id, {
          asaasPaymentId: payment.id,
          invoiceUrl: payment.invoiceUrl,
        });
      }
      return open ?? (await this.repo.findChargeByAsaasPaymentId(payment.id));
    }
  }

  /**
   * Aplica os assentos de uma compra **paga** (B6) — antes do pagamento o cliente teria
   * acesso sem ter pago, que é o modo mais fácil de dar produto de graça.
   *
   * Dois desfechos, um por plano:
   * - **mensal:** `purchasedSeats` sobe e a recorrência passa a valer mais **da próxima
   *   cobrança em diante** (`updatePendingPayments: false` no cliente Asaas) — o mês
   *   corrente já foi pago com os assentos antigos e o novo saiu na avulsa;
   * - **anual:** ativa a assinatura de assentos, define o ano dela e recalcula o
   *   contador `addonSeats`.
   */
  private async applyPaidSeats(charge: BillingCharge, payment: AsaasPayment): Promise<void> {
    if (charge.seatAddonId) {
      await this.ativarAddon(charge, payment);
      return;
    }
    if (!charge.seatsDelta) return;

    const sub = await this.repo.findSubscriptionById(charge.subscriptionId);
    await this.repo.updateSubscription(charge.subscriptionId, {
      purchasedSeats: { increment: charge.seatsDelta },
    });
    if (sub?.method === 'monthly_card' && sub.asaasSubscriptionId) {
      await this.syncMonthlyValue(
        sub.asaasSubscriptionId,
        sub.purchasedSeats + charge.seatsDelta,
        charge.companyId,
      );
    }
  }

  /**
   * Primeira cobrança de uma assinatura de assentos anual paga: o bloco passa a valer
   * por um ano, com renovação própria. No cartão é aqui que descobrimos qual assinatura
   * o checkout criou.
   */
  private async ativarAddon(charge: BillingCharge, payment: AsaasPayment): Promise<void> {
    const addon = await this.repo.findSeatAddonById(charge.seatAddonId!);
    if (!addon || addon.status !== 'pending') return;

    const asaasSubscriptionId =
      addon.asaasSubscriptionId ?? (await this.descobrirAssinaturaDoAddon(charge, addon, payment));
    const inicio = new Date();
    await this.repo.updateSeatAddon(addon.id, {
      status: 'active',
      activatedAt: inicio,
      currentPeriodStart: inicio,
      currentPeriodEnd: addYears(inicio, 1),
      graceUntil: null,
      ...(asaasSubscriptionId ? { asaasSubscriptionId } : {}),
    });
    const total = await this.repo.syncAddonSeats(charge.subscriptionId, charge.companyId);
    this.logger.info(
      { companyId: charge.companyId, addonId: addon.id, seats: addon.seats, addonSeats: total },
      'Assinatura de assentos anual ativada',
    );
  }

  private async descobrirAssinaturaDoAddon(
    charge: BillingCharge,
    addon: SeatAddon,
    payment: AsaasPayment,
  ): Promise<string | null> {
    if (payment.subscription) return payment.subscription;
    const sub = await this.repo.findSubscriptionById(charge.subscriptionId);
    if (!sub) return null;
    const encontrada = await this.checkout.resolverAssinatura(charge, sub, 'YEARLY');
    if (!encontrada) {
      // Sem o id, a renovação e o cancelamento ficam cegos. O assento é entregue (o
      // cliente pagou), mas isso precisa de olho humano.
      await this.alerts.raise('addon_subscription_orphan', {
        companyId: charge.companyId,
        addonId: addon.id,
        chargeId: charge.id,
        paymentId: payment.id,
      });
    }
    return encontrada;
  }

  /**
   * Grava o `asaasSubscriptionId` do plano quando ele nasce de um checkout recorrente.
   * Sem isto não dá para reajustar o valor da mensalidade nem cancelar a recorrência —
   * a assinatura existiria só do lado do Asaas.
   */
  private async vincularAssinaturaDoPagamento(
    charge: BillingCharge,
    payment: AsaasPayment,
  ): Promise<void> {
    const sub = await this.repo.findSubscriptionById(charge.subscriptionId);
    if (!sub || sub.asaasSubscriptionId) return;
    if (sub.method !== 'monthly_card') return;

    const id =
      payment.subscription ?? (await this.checkout.resolverAssinatura(charge, sub, 'MONTHLY'));
    if (!id) {
      await this.alerts.raise('checkout_unresolved', {
        companyId: charge.companyId,
        chargeId: charge.id,
        checkoutId: charge.asaasCheckoutId,
        paymentId: payment.id,
      });
      return;
    }
    await this.repo.updateSubscription(sub.id, { asaasSubscriptionId: id });
    this.logger.info(
      { companyId: charge.companyId, asaasSubscriptionId: id },
      'Assinatura criada pelo checkout vinculada à empresa',
    );
  }

  /** Alinha o valor da recorrência ao total de assentos. Best-effort (loga e segue). */
  private async syncMonthlyValue(
    asaasSubscriptionId: string,
    seats: number,
    companyId: string,
  ): Promise<void> {
    try {
      await this.asaas.updateSubscriptionValue(asaasSubscriptionId, monthlyValueReais(seats));
    } catch (err: unknown) {
      this.logger.error(
        { companyId, asaasSubscriptionId, seats, err },
        'Falha ao atualizar valor da assinatura no Asaas',
      );
    }
  }

  /** E-mail de pagamento confirmado (R24). Best-effort — o webhook nunca quebra por e-mail. */
  private async notifyPaymentConfirmed(companyId: string, amountCents: number): Promise<void> {
    try {
      const to = await this.repo.findCompanyAdminEmails(companyId);
      const amountLabel = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }).format(amountCents / 100);
      await this.mailer.sendPaymentConfirmedEmail(to, companyId, amountLabel);
    } catch (err: unknown) {
      this.logger.warn({ companyId, err }, 'Falha ao enviar e-mail de pagamento confirmado');
    }
  }

  /** Renova o ciclo do plano a partir de um pagamento confirmado. */
  private async activate(subscriptionId: string): Promise<void> {
    const sub = await this.repo.findSubscriptionById(subscriptionId);
    if (!sub) return;
    // Bloqueio manual do superadmin não é reativado por pagamento.
    if (sub.superadminLocked) {
      this.logger.warn({ subscriptionId }, 'Assinatura travada pelo superadmin — não reativada');
      return;
    }

    const now = new Date();
    const isAnnual = sub.method === 'annual_pix' || sub.method === 'annual_card';
    const aplicaReducao = sub.seatsAtNextRenewal != null;
    // O ciclo novo começa onde o atual termina, não "agora" (R47). Quem renova antes
    // de vencer não pode perder os dias que já pagou — e o mensal também ganha com
    // isso: o cartão às vezes confirma antes do vencimento, e esse dia sumia.
    const inicio = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
    await this.repo.updateSubscription(subscriptionId, {
      status: 'active',
      graceUntil: null,
      currentPeriodStart: inicio,
      currentPeriodEnd: isAnnual ? addYears(inicio, 1) : addMonths(inicio, 1),
      // Aplica a redução de assentos agendada para a renovação (R19).
      ...(aplicaReducao
        ? { purchasedSeats: sub.seatsAtNextRenewal as number, seatsAtNextRenewal: null }
        : {}),
    });

    // Ciclo novo começou: quem o admin marcou para sair perde o acesso agora — até
    // aqui a pessoa trabalhou dentro do ciclo que a empresa já tinha pago.
    if (aplicaReducao) {
      const { count } = await this.repo.applyScheduledSeatRemovals(sub.companyId, now);
      if (count > 0) {
        this.logger.info(
          { companyId: sub.companyId, removidos: count },
          'Saídas agendadas efetivadas na renovação',
        );
      }
    }
  }

  /** A assinatura de assentos anual dona de um pagamento, se for o caso. */
  private async addonDoPagamento(payment: AsaasPayment): Promise<SeatAddon | null> {
    if (payment.subscription) {
      const bySub = await this.repo.findSeatAddonByAsaasSubscription(payment.subscription);
      if (bySub) return bySub;
    }
    const ref = payment.externalReference;
    if (ref && UUID_RE.test(ref)) return this.repo.findSeatAddonById(ref);
    return null;
  }

  private async onOverdue(payment: AsaasPayment): Promise<void> {
    // Atraso numa assinatura de assentos não põe a EMPRESA em carência: o plano
    // continua pago. Quem entra em carência é o bloco de assentos, e só ele cai.
    const addon = await this.addonDoPagamento(payment);
    if (addon) {
      if (addon.status !== 'active') return;
      const graceUntil = addDays(this.parseDueDate(payment.dueDate), GRACE_DAYS);
      await this.repo.updateSeatAddon(addon.id, { status: 'past_due', graceUntil });
      this.logger.warn(
        { companyId: addon.companyId, addonId: addon.id, graceUntil },
        'Renovação de assentos em atraso — em carência',
      );
      return;
    }

    const sub = await this.resolveSubscription(payment);
    if (!sub || sub.status !== 'active') return;

    const graceUntil = addDays(this.parseDueDate(payment.dueDate), GRACE_DAYS);
    await this.repo.updateSubscription(sub.id, { status: 'past_due', graceUntil });
    this.access.invalidate(sub.companyId);
    this.logger.warn(
      { companyId: sub.companyId, graceUntil },
      'Renovação em atraso — entrando em carência',
    );
    // Aviso de falha + prazo de carência (R22). Best-effort.
    try {
      const to = await this.repo.findCompanyAdminEmails(sub.companyId);
      await this.mailer.sendPaymentFailedEmail(to, sub.companyId, graceUntil, payment.invoiceUrl);
    } catch (err: unknown) {
      this.logger.warn(
        { companyId: sub.companyId, err },
        'Falha ao enviar e-mail de falha de pagamento',
      );
    }
  }

  /**
   * Estorno/chargeback (B8): marca a cobrança e **alerta** — o acesso NÃO é cortado
   * automaticamente (disputa de cartão é comum e bloquear na hora pune cliente
   * legítimo) e os assentos não são revertidos (deixaria membro ativo sem assento).
   * A decisão é do financeiro, na tela do superadmin.
   */
  private async onReversed(payment: AsaasPayment): Promise<void> {
    const charge = await this.findChargeForPayment(payment);
    if (charge) {
      await this.repo.updateCharge(charge.id, { status: 'refunded' });
    }
    await this.alerts.raise('payment_reversed', {
      paymentId: payment.id,
      status: payment.status,
      value: payment.value,
      chargeId: charge?.id ?? null,
      companyId: charge?.companyId ?? null,
    });
  }

  private parseDueDate(dueDate: string): Date {
    // "yyyy-MM-dd" no horário de Brasília.
    return new Date(`${dueDate}T00:00:00-03:00`);
  }
}
