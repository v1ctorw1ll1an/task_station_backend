import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { addMonths, addYears, subHours } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type {
  BillingCharge,
  BillingMethod,
  ChargeType,
  MembershipRole,
  Subscription,
} from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { AsaasClient } from './asaas/asaas.client';
import { externalReference, resolveGroupName } from './asaas/asaas-identity';
import type { AsaasPayment, CreatePaymentInput } from './asaas/asaas.types';
import { toCsv } from './billing-export';
import { normalizeTaxId } from '../common/tax-id';
import { BillingRepository } from './billing.repository';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingPreviewQueryDto, PreviewMethod } from './dto/billing-preview-query.dto';
import { ListChargesQueryDto } from './dto/list-charges-query.dto';
import { SubscribeAnnualCardDto } from './dto/subscribe-annual-card.dto';
import { SeatsChoiceDto } from './dto/seats-choice.dto';
import { SubscribeAnnualPixDto } from './dto/subscribe-annual-pix.dto';
import { SubscribeMonthlyPixDto } from './dto/subscribe-monthly-pix.dto';
import { SubscribeMonthlyDto } from './dto/subscribe-monthly.dto';
import { cycleOf, isAnnual, isCard, isMonthly } from './billing-method';
import {
  ANNUAL_DISCOUNT,
  ANNUAL_SEAT_CENTS,
  annualSeatChargeCents,
  annualSeatValueReais,
  annualTotalCents,
  entitledSeats,
  MAX_SEATS,
  MONTHLY_BASE_CENTS,
  MONTHLY_EXTRA_SEAT_CENTS,
  monthlySeatChargeCents,
  monthlyTotalCents,
  monthlyValueReais,
} from './pricing';
import { BuySeatsDto, ReduceSeatsDto, SeatPreviewQueryDto } from './dto/seats.dto';
import { UpdateBillingAddressDto } from './dto/update-billing-address.dto';

/** Perfil de cobrança já normalizado (só dígitos onde o Asaas espera dígitos). */
type PerfilCobranca = ReturnType<typeof normalizarPerfil>;

/**
 * Tira a máscara de documento, CEP e telefone antes de qualquer coisa sair daqui.
 * Os DTOs aceitam "123.456.789-09" (é o que a tela manda), mas o Asaas quer só
 * dígitos — e o perfil guardado precisa ficar num formato só, senão o formulário
 * volta preenchido com máscara de uma origem e sem de outra.
 */
function normalizarPerfil(dto: UpdateBillingAddressDto) {
  const digitos = (v: string | undefined) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');
  return {
    name: dto.name,
    email: dto.email,
    cpfCnpj: digitos(dto.cpfCnpj),
    postalCode: digitos(dto.postalCode),
    street: dto.street,
    addressNumber: dto.addressNumber,
    addressComplement: dto.addressComplement ?? null,
    neighborhood: dto.neighborhood,
    city: dto.city,
    state: dto.state?.toUpperCase(),
    phone: digitos(dto.phone),
  };
}

const TZ = 'America/Sao_Paulo';
/** Situações em que o Asaas considera o dinheiro entrado (não dá para cancelar). */
const PAID_ASAAS_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);
/** Janela de cobranças pendentes conciliadas sob demanda no `getStatus` (B7). */
const ON_DEMAND_RECONCILE_HOURS = 48;
const ON_DEMAND_RECONCILE_LIMIT = 3;
/** Intervalo mínimo entre duas conciliações sob demanda da mesma empresa (B7). */
const ON_DEMAND_RECONCILE_COOLDOWN_MS = 30_000;

@Injectable()
export class BillingService {
  /** Última conciliação sob demanda por empresa — evita martelar o Asaas a cada refresh. */
  private readonly reconcileCooldown = new Map<string, number>();

  constructor(
    private readonly repo: BillingRepository,
    private readonly asaas: AsaasClient,
    private readonly config: ConfigService,
    private readonly webhook: BillingWebhookService,
    private readonly checkout: BillingCheckoutService,
    private readonly mailer: MailerService,
    @InjectPinoLogger(BillingService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Leitura ──────────────────────────────────────────────────────────────

  async getStatus(companyId: string) {
    // Rede de segurança p/ webhook perdido/atrasado: concilia pagamentos pendentes
    // direto no Asaas antes de montar o status (paga → recarrega → ativa).
    await this.reconcilePending(companyId);
    // E cura o caso em que a cobrança já foi paga mas a ativação não completou (B18).
    await this.repairStuck(companyId);
    const sub = await this.getSubscriptionOrThrow(companyId);
    const [occupiedSeats, pendingPix, pendingCharge, fiscal, addons] = await Promise.all([
      this.repo.countOccupiedSeats(companyId),
      this.repo.findPendingPixCharge(companyId),
      this.repo.findLatestPendingCharge(companyId),
      this.repo.getCompanyFiscal(companyId),
      this.repo.findSeatAddons(companyId, ['pending', 'active', 'past_due']),
    ]);
    const totalSeats = entitledSeats(sub);

    return {
      status: sub.status,
      method: sub.method,
      /** Total a que a empresa tem direito: plano + assentos avulsos do anual. */
      purchasedSeats: totalSeats,
      /** Aberto em duas partes para a tela poder explicar de onde vem cada assento. */
      planSeats: sub.purchasedSeats,
      addonSeats: sub.addonSeats,
      seatsAtNextRenewal: sub.seatsAtNextRenewal,
      occupiedSeats,
      availableSeats: totalSeats - occupiedSeats,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      /** Prazo da carência do cartão recusado — a tela precisa dizer até quando dá para resolver. */
      graceUntil: sub.graceUntil,
      /**
       * Assinaturas de assentos adicionais do plano anual, cada uma com a sua data de
       * renovação. Só existem no anual; no mensal os assentos entram no valor da
       * própria recorrência.
       */
      seatAddons: addons.map((a) => ({
        id: a.id,
        seats: a.seats,
        status: a.status,
        amountCents: a.amountCents,
        paymentKind: a.paymentKind,
        currentPeriodEnd: a.currentPeriodEnd,
      })),
      /**
       * Mexer em assentos só existe no mensal-cartão: é o único plano com recorrência
       * para reajustar. A tela usa isto para esconder as opções em vez de deixar o
       * cliente descobrir pelo 400.
       */
      canChangeSeats: isMonthly(sub.method),
      prices: {
        monthlyCents: monthlyTotalCents(sub.purchasedSeats),
        annualCents: annualTotalCents(sub.purchasedSeats),
        /**
         * Componentes da fórmula, para a tela abrir a conta ("acesso da empresa +
         * 1 assento" / "por assento adicional") sem reimplementar o preço. O total
         * de uma quantidade diferente vem de `GET /preview`, que é quem cobra.
         */
        baseCents: MONTHLY_BASE_CENTS,
        extraSeatCents: MONTHLY_EXTRA_SEAT_CENTS,
        /** Preço cheio de um assento adicional no anual, por ano. */
        annualSeatCents: ANNUAL_SEAT_CENTS,
        maxSeats: MAX_SEATS,
        /** Desconto do anual em % inteiro — a tela anuncia o número, não o adivinha. */
        annualDiscountPercent: Math.round(ANNUAL_DISCOUNT * 100),
      },
      /**
       * Dados fiscais da empresa — razão social e documento. Ficam na `Company`, mas
       * a tela de cobrança é onde o admin tem motivo para corrigi-los (é o que sai
       * na nota), e é o único lugar em que ele consegue: editar empresa, fora daqui,
       * é exclusivo do superadmin.
       */
      company: { legalName: fiscal?.legalName ?? '', taxId: fiscal?.taxId ?? '' },
      /**
       * Perfil de cobrança já informado. `null` enquanto ninguém preencheu. Não há
       * nada de cartão aqui — o cartão é digitado na página do Asaas.
       */
      billingAddress: sub.billingCpfCnpj
        ? {
            name: sub.billingName ?? '',
            email: sub.billingEmail ?? '',
            cpfCnpj: sub.billingCpfCnpj,
            postalCode: sub.billingPostalCode ?? '',
            street: sub.billingStreet ?? '',
            addressNumber: sub.billingAddressNumber ?? '',
            addressComplement: sub.billingAddressComplement ?? '',
            neighborhood: sub.billingNeighborhood ?? '',
            city: sub.billingCity ?? '',
            state: sub.billingState ?? '',
            phone: sub.billingPhone ?? '',
          }
        : null,
      /**
       * Se dá para mandar o cliente pagar. O checkout hospedado exibe o cadastro do
       * cliente, então o perfil precisa estar completo **antes** — a tela pede os
       * dados em vez de deixar o pagamento falhar lá no Asaas.
       */
      profileComplete: this.perfilCompleto(sub),
      pendingPix: pendingPix
        ? {
            payload: pendingPix.pixPayload,
            encodedImage: pendingPix.pixEncodedImage,
            expiresAt: pendingPix.pixExpiresAt,
            amountCents: pendingPix.amountCents,
          }
        : null,
      /**
       * Cobrança aguardando confirmação, de qualquer forma de pagamento. Diferente
       * do `pendingPix`, cobre o cartão — é o que faz a tela oferecer o "Já paguei"
       * também para quem pagou no cartão e ainda não viu o acesso liberar.
       */
      pendingCharge: pendingCharge
        ? {
            id: pendingCharge.id,
            paymentKind: pendingCharge.paymentKind,
            amountCents: pendingCharge.amountCents,
            installments: pendingCharge.installments,
            invoiceUrl: pendingCharge.invoiceUrl,
            /** Link para retomar um pagamento com cartão que ficou pela metade (D10). */
            checkoutUrl: this.checkoutVivo(pendingCharge) ? pendingCharge.checkoutUrl : null,
            checkoutExpiresAt: pendingCharge.checkoutExpiresAt,
            createdAt: pendingCharge.createdAt,
          }
        : null,
    };
  }

  /**
   * O checkout hospedado mostra o cadastro do cliente e o Asaas recusa customer sem
   * documento. Exigir o perfil aqui transforma um erro do provedor (que o cliente lê
   * como "o site quebrou") num formulário nosso, antes de sair do app.
   */
  private perfilCompleto(sub: Subscription): boolean {
    return Boolean(
      sub.billingName &&
      sub.billingEmail &&
      sub.billingCpfCnpj &&
      sub.billingPostalCode &&
      sub.billingStreet &&
      sub.billingAddressNumber &&
      sub.billingNeighborhood &&
      sub.billingCity &&
      sub.billingState &&
      sub.billingPhone,
    );
  }

  private assertPerfilCompleto(sub: Subscription): void {
    if (this.perfilCompleto(sub)) return;
    throw new BadRequestException({
      code: 'BILLING_PROFILE_INCOMPLETE',
      message: 'Complete os dados de cobrança antes de continuar para o pagamento',
    });
  }

  private checkoutVivo(charge: BillingCharge, now: Date = new Date()): boolean {
    return Boolean(
      charge.checkoutUrl && charge.checkoutExpiresAt && charge.checkoutExpiresAt > now,
    );
  }

  /**
   * "Já paguei" — conferência sob demanda, disparada pelo cliente que acabou de
   * pagar e não quer esperar o webhook.
   *
   * O `getStatus` já concilia, mas com cooldown de 30s por empresa (B7) para não
   * virar rajada no Asaas a cada abertura de tela. Aqui o cooldown é furado de
   * propósito: é um clique explícito de quem está olhando o comprovante, não o
   * caminho quente. O throttle da rota é que segura o abuso.
   *
   * Devolve `pago` de forma honesta: só é `true` se **alguma cobrança que estava
   * pendente virou paga**, ou se a assinatura saiu de bloqueada para ativa. Olhar
   * apenas "status === active" mentiria para quem renova antes de vencer — nesse
   * caso a empresa já estava ativa antes do pagamento.
   */
  async conferirPagamento(companyId: string) {
    this.assertBillingEnabled();
    const sub = await this.getSubscriptionOrThrow(companyId);
    const statusAntes = sub.status;
    const pendentesAntes = await this.repo.findPendingChargesByCompany(
      companyId,
      subHours(new Date(), ON_DEMAND_RECONCILE_HOURS),
      ON_DEMAND_RECONCILE_LIMIT,
    );

    this.reconcileCooldown.delete(companyId);
    await this.reconcilePending(companyId);
    // Cobrança nascida de checkout ainda não tem `asaasPaymentId` — o `reconcilePending`
    // não a enxerga. Aqui procuramos no Asaas o pagamento que ela gerou.
    await this.casarCheckoutsPendentes(sub, pendentesAntes);

    // No mensal a cobrança da renovação nasce no Asaas e só vira `BillingCharge`
    // quando processada — sem isto, "Já paguei" não enxergaria a mensalidade que
    // acabou de ser paga no cartão.
    if (isMonthly(sub.method) && sub.asaasSubscriptionId) {
      try {
        await this.webhook.reconcileSubscription(sub.asaasSubscriptionId);
      } catch (err: unknown) {
        this.logger.warn(
          { companyId, asaasSubscriptionId: sub.asaasSubscriptionId, err },
          'Conferência da recorrência falhou (segue com o status atual)',
        );
      }
    }

    await this.repairStuck(companyId);

    const quitadas: string[] = [];
    for (const c of pendentesAntes) {
      const atual = await this.repo.findChargeById(c.id);
      if (atual?.status === 'paid') quitadas.push(c.id);
    }

    const status = await this.getStatus(companyId);
    const pago = quitadas.length > 0 || (statusAntes !== 'active' && status.status === 'active');

    this.logger.info(
      { companyId, pago, quitadas: quitadas.length, statusAntes, statusDepois: status.status },
      'Conferência de pagamento a pedido do cliente',
    );
    return { pago, status };
  }

  /**
   * Concilia cobranças pendentes **recentes** da empresa direto no Asaas (rede de
   * segurança para webhook perdido/atrasado). Reusa `reconcilePayment` — idempotente:
   * se o pagamento consta pago, ativa a assinatura e invalida o cache do gate.
   * Não-fatal: falha no Asaas não interrompe a leitura do status.
   *
   * Limitado por janela, quantidade e cooldown por empresa (B7): o `getStatus` é
   * caminho quente (abre a tela e fecha toda mutação) e não pode virar uma rajada
   * de chamadas externas. O que sobra é do cron.
   */
  private async reconcilePending(companyId: string): Promise<void> {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') return;

    const last = this.reconcileCooldown.get(companyId) ?? 0;
    if (Date.now() - last < ON_DEMAND_RECONCILE_COOLDOWN_MS) return;
    this.reconcileCooldown.set(companyId, Date.now());

    let pending: { id: string; asaasPaymentId: string | null }[] = [];
    try {
      pending = await this.repo.findPendingChargesByCompany(
        companyId,
        subHours(new Date(), ON_DEMAND_RECONCILE_HOURS),
        ON_DEMAND_RECONCILE_LIMIT,
      );
    } catch {
      return;
    }
    for (const c of pending) {
      if (!c.asaasPaymentId) continue;
      try {
        await this.webhook.reconcilePayment(c.asaasPaymentId);
      } catch (err: unknown) {
        this.logger.warn(
          { companyId, chargeId: c.id, err },
          'Reconcile sob demanda falhou (segue com o status atual)',
        );
      }
    }
  }

  /**
   * Liga as cobranças de checkout ao pagamento que elas geraram no Asaas.
   *
   * É a peça que faz o "Já paguei" funcionar no cartão: como o checkout não tem GET e
   * o pagamento nasce do lado de lá, sem isto a cobrança ficaria pendente até o webhook
   * chegar. `casarPagamento` devolve `null` quando há qualquer ambiguidade — e aí
   * preferimos não confirmar nada a confirmar errado.
   */
  private async casarCheckoutsPendentes(
    sub: Subscription,
    pendentes: { id: string; asaasPaymentId: string | null }[],
  ): Promise<void> {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') return;
    for (const p of pendentes) {
      if (p.asaasPaymentId) continue; // já ligada — `reconcilePending` cuidou
      const charge = await this.repo.findChargeById(p.id);
      if (!charge?.asaasCheckoutId) continue;
      try {
        const payment = await this.checkout.casarPagamento(charge, sub);
        if (!payment) continue;
        await this.repo.updateCharge(charge.id, {
          asaasPaymentId: payment.id,
          invoiceUrl: payment.invoiceUrl,
        });
        await this.webhook.reconcilePayment(payment.id);
      } catch (err: unknown) {
        this.logger.warn(
          { companyId: sub.companyId, chargeId: charge.id, err },
          'Falha ao casar o pagamento do checkout (segue com o status atual)',
        );
      }
    }
  }

  /** Auto-cura de ativação interrompida — não-fatal (B18). */
  private async repairStuck(companyId: string): Promise<void> {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') return;
    try {
      await this.webhook.repairStuckActivation(companyId);
    } catch (err: unknown) {
      this.logger.warn({ companyId, err }, 'Falha ao curar ativação interrompida');
    }
  }

  /**
   * Quanto custa contratar, por método. Os dois anuais custam o mesmo — o desconto de
   * 25% vale para Pix e cartão, e não há mais parcelamento para diferenciá-los.
   */
  getPreview(query: BillingPreviewQueryDto) {
    const { seats, method } = query;
    const totalCents =
      method === PreviewMethod.monthly ? monthlyTotalCents(seats) : annualTotalCents(seats);
    return { method, seats, totalCents, installments: 1 };
  }

  async getHistory(companyId: string, query: ListChargesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [data, total] = await this.repo.findCharges(companyId, page, limit);
    return { data, total, page, limit };
  }

  // ── Assinatura ───────────────────────────────────────────────────────────

  /**
   * Quantos assentos a contratação vai comprar. Sem escolha explícita mantém o que
   * a empresa já tem — no caso comum, o assento único do trial.
   *
   * Duas recusas:
   * - **plano vigente** (`active`/`past_due`): mudar assento aí é o
   *   `/assentos/comprar`, que cobra o assento. Aceitar o campo aqui trocaria o
   *   total sem cobrar nada;
   * - **menos assentos que gente dentro**: o plano nasceria estourado, e o primeiro
   *   `assertSeatAvailable` barraria o próprio time que já está trabalhando.
   */
  private async resolverAssentos(
    sub: Subscription,
    companyId: string,
    escolha: number | undefined,
  ): Promise<number> {
    if (escolha == null) return sub.purchasedSeats;
    if (sub.status === 'active' || sub.status === 'past_due') {
      throw new BadRequestException('Com plano vigente, use a compra de usuários adicionais');
    }
    const ocupados = await this.repo.countOccupiedSeats(companyId);
    if (escolha < ocupados) {
      throw new BadRequestException(
        `A empresa já tem ${ocupados} pessoa(s). Contrate ao menos ${ocupados} usuário(s) ou remova alguém antes.`,
      );
    }
    return escolha;
  }

  /**
   * Assinar o mensal — o único plano com recorrência automática no cartão.
   *
   * Quem cria a assinatura no Asaas é o **checkout**: mandamos o cliente para a página
   * hospedada e ele volta pago. Por isso aqui não existe `asaasSubscriptionId` ainda;
   * ele é descoberto no webhook (`BillingCheckoutService.resolverAssinatura`). O que
   * gravamos agora é a intenção: uma cobrança pendente com o link.
   */
  async subscribeMonthly(companyId: string, dto: SubscribeMonthlyDto) {
    this.assertBillingEnabled();
    return this.repo.withCompanyLock(companyId, async () => {
      const sub = await this.getSubscriptionOrThrow(companyId);
      this.assertPerfilCompleto(sub);
      const seats = await this.resolverAssentos(sub, companyId, dto.seats);
      const inicio = await this.prepareForNewSubscription(sub, companyId);
      // Usa o id devolvido, não uma releitura: com read-after-write a assinatura
      // poderia voltar sem o customer recém-criado e o checkout falharia sem motivo.
      const atualizada = { ...sub, asaasCustomerId: await this.ensureCustomer(sub, companyId) };

      const amountCents = monthlyTotalCents(seats);
      // Mesmo intento e mesma quantidade → devolve o link que já existe em vez de
      // abrir um segundo checkout (D10). Método/quantidade diferentes cancelam.
      const aberta = await this.settleOpenCharge(
        atualizada.id,
        'subscription',
        'monthly_card',
        new Date(),
        seats,
      );

      const charge =
        aberta ??
        (await this.repo.createCharge({
          subscriptionId: atualizada.id,
          companyId,
          type: 'subscription',
          paymentKind: 'credit_card',
          status: 'pending',
          amountCents,
          installments: 1,
          seats,
          periodStart: inicio,
          periodEnd: null,
          metadata: { method: 'monthly_card', intent: 'plan_monthly' },
        }));

      // A 1ª cobrança cai no fim do ciclo já pago — no plano novo de quem não tinha
      // cobertura, isso é "hoje" (R47). É o que permite trocar de plano sem pagar duas
      // vezes o mesmo período.
      const sessao = await this.checkout.abrir(charge, atualizada, 'plan_monthly', {
        descricao: `TaskDY mensal (${seats} usuário${seats > 1 ? 's' : ''})`,
        amountCents,
        cycle: 'MONTHLY',
        nextDueDate: inicio,
      });

      await this.repo.updateSubscription(atualizada.id, {
        method: 'monthly_card',
        purchasedSeats: seats,
      });

      this.logger.info(
        { companyId, subscriptionId: atualizada.id, chargeId: charge.id, seats },
        'Checkout do plano mensal aberto',
      );
      return { ...sessao, status: await this.getStatus(companyId) };
    });
  }

  /**
   * Assinar o mensal no Pix — assinatura MONTHLY nativa do Asaas.
   *
   * É a forma de pagamento de quem não tem cartão de crédito. **Não é débito
   * automático:** o Asaas emite um Pix novo a cada mês e o cliente paga o QR. Pix
   * Automático (com débito de verdade) foi descartado porque o valor fica congelado no
   * consentimento do pagador, e o preço daqui varia com a quantidade de assentos.
   */
  async subscribeMonthlyPix(companyId: string, dto: SubscribeMonthlyPixDto = {}) {
    return this.contratarAssinaturaPix(companyId, dto, 'monthly_pix');
  }

  /**
   * Assinar o anual no Pix. Assinatura YEARLY nativa do Asaas: o provedor gera a
   * cobrança de cada ano sozinho e o cliente só paga o Pix novo — some a recontratação
   * manual que o anual exigia.
   */
  async subscribeAnnualPix(companyId: string, dto: SubscribeAnnualPixDto = {}) {
    return this.contratarAssinaturaPix(companyId, dto, 'annual_pix');
  }

  /**
   * O caminho comum dos dois planos em Pix. Só a cadência muda — valor, ciclo e período
   * saem dela — e manter isto num lugar só é o que garante que mensal e anual não
   * divirjam em cima de uma correção feita num deles.
   *
   * O Pix é exibido por nós (QR + copia-e-cola), não pelo checkout hospedado: não há
   * cartão envolvido, então não há motivo para tirar o cliente do app.
   */
  private async contratarAssinaturaPix(
    companyId: string,
    dto: SeatsChoiceDto,
    method: 'monthly_pix' | 'annual_pix',
  ) {
    this.assertBillingEnabled();
    const anual = isAnnual(method);
    return this.repo.withCompanyLock(companyId, async () => {
      const sub = await this.getSubscriptionOrThrow(companyId);
      this.assertPerfilCompleto(sub);
      const seats = await this.resolverAssentos(sub, companyId, dto.seats);
      this.assertSemCancelamentoAgendado(sub);

      const now = new Date();
      const amountCents = anual ? annualTotalCents(seats) : monthlyTotalCents(seats);

      // ANTES de qualquer coisa destrutiva: já existe um Pix aberto e válido para o
      // mesmo plano **e a mesma quantidade**? Então devolve o MESMO QR (B2). Fazer o
      // teardown primeiro apagaria a assinatura que gerou esse QR — o duplo clique
      // deixaria o cliente com um código de barras que não cobra mais nada.
      const reused = await this.settleOpenCharge(sub.id, 'subscription', method, now, seats);
      if (reused) return this.getStatus(companyId);

      const inicio = await this.prepareForNewSubscription(sub, companyId);
      const customerId = await this.ensureCustomer(sub, companyId);

      // A cobrança local nasce ANTES da assinatura no Asaas: é o índice único parcial
      // que decide quem ganha a corrida do duplo clique, e perder essa corrida depois
      // de criar a assinatura deixaria uma recorrência órfã cobrando o cliente.
      // O período cobre a partir da âncora (renovação antecipada começa onde o ciclo
      // atual termina). É por estas datas que a auto-cura sabe se há cobertura paga (B18).
      const charge = await this.repo.createCharge({
        subscriptionId: sub.id,
        companyId,
        type: 'subscription',
        paymentKind: 'pix',
        status: 'pending',
        amountCents,
        installments: 1,
        seats,
        periodStart: inicio,
        periodEnd: anual ? addYears(inicio, 1) : addMonths(inicio, 1),
        metadata: { method },
      });

      const cadencia = anual ? 'anual' : 'mensal';
      let asaasSub: { id: string };
      try {
        asaasSub = await this.asaas.createSubscription({
          customer: customerId,
          billingType: 'PIX',
          value: this.reais(amountCents),
          cycle: cycleOf(method),
          nextDueDate: formatInTimeZone(inicio, TZ, 'yyyy-MM-dd'),
          externalReference: externalReference(sub.id),
          description: `TaskDY — assinatura ${cadencia} (${seats} usuário(s))`,
        });
      } catch (err: unknown) {
        await this.failCharge(charge.id, err);
        throw err;
      }

      await this.repo.updateSubscription(sub.id, {
        method,
        purchasedSeats: seats,
        asaasCustomerId: customerId,
        asaasSubscriptionId: asaasSub.id,
      });

      // A cobrança da assinatura é gerada pelo Asaas. Buscar o QR dela pode falhar (ou
      // a cobrança ainda não existir) — nesse caso a charge fica pendente e o cron/o
      // "Já paguei" a reconciliam. Não vale derrubar a contratação por causa disso.
      await this.anexarPixDaAssinatura(charge, asaasSub.id, companyId);

      this.logger.info(
        {
          companyId,
          subscriptionId: sub.id,
          chargeId: charge.id,
          asaasSubscriptionId: asaasSub.id,
          method,
          seats,
        },
        `Assinatura ${cadencia} (Pix) criada no Asaas`,
      );
      return this.getStatus(companyId);
    });
  }

  /**
   * Anexa à cobrança local o QR da primeira fatura de uma assinatura Pix recém-criada.
   *
   * Vale ressalvar: **não está garantido** que o Asaas gere a fatura no mesmo instante
   * em que a assinatura nasce. Quando não gerar, o QR simplesmente não aparece agora e
   * o cliente o vê no próximo carregamento da tela (o cron e o "Já paguei" religam a
   * cobrança). Por isso este passo nunca lança.
   */
  private async anexarPixDaAssinatura(
    charge: BillingCharge,
    asaasSubscriptionId: string,
    companyId: string,
  ): Promise<void> {
    try {
      const { data } = await this.asaas.listSubscriptionPayments(asaasSubscriptionId);
      const primeira = (data ?? []).find((p) => p.status === 'PENDING') ?? (data ?? [])[0];
      if (!primeira) {
        this.logger.info(
          { companyId, asaasSubscriptionId },
          'Assinatura criada, cobrança ainda não gerada — QR virá na conciliação',
        );
        return;
      }
      await this.repo.updateCharge(charge.id, {
        asaasPaymentId: primeira.id,
        invoiceUrl: primeira.invoiceUrl,
      });
      const qr = await this.asaas.getPixQrCode(primeira.id);
      await this.repo.updateCharge(charge.id, {
        pixPayload: qr.payload,
        pixEncodedImage: qr.encodedImage,
        pixExpiresAt: this.parseAsaasDate(qr.expirationDate),
      });
    } catch (err: unknown) {
      this.logger.warn(
        { companyId, chargeId: charge.id, asaasSubscriptionId, err },
        'Não foi possível anexar o QR da assinatura agora (a conciliação resolve)',
      );
    }
  }

  /**
   * Assinar o anual no cartão: pagamento único por ano, na página hospedada do Asaas.
   *
   * É uma **assinatura YEARLY**, não uma compra avulsa. Era o parcelamento que o
   * impedia — o Asaas não combina parcelamento com assinatura — e com o 12× fora do
   * produto a trava caiu. O Asaas guarda o cartão e cobra o ano seguinte sozinho; o
   * cron D-15/D-7/D-1 deixou de ser cobrança manual e virou aviso prévio do débito.
   */
  async subscribeAnnualCard(companyId: string, dto: SubscribeAnnualCardDto) {
    this.assertBillingEnabled();
    return this.repo.withCompanyLock(companyId, async () => {
      const sub = await this.getSubscriptionOrThrow(companyId);
      this.assertPerfilCompleto(sub);
      const seats = await this.resolverAssentos(sub, companyId, dto.seats);
      const inicio = await this.prepareForNewSubscription(sub, companyId);
      const atualizada = { ...sub, asaasCustomerId: await this.ensureCustomer(sub, companyId) };

      const now = new Date();
      const amountCents = annualTotalCents(seats);

      // Checkout aberto do mesmo intento → devolve o link em vez de criar outro (D10).
      const aberta = await this.settleOpenCharge(
        atualizada.id,
        'subscription',
        'annual_card',
        now,
        seats,
      );

      const charge =
        aberta ??
        (await this.repo.createCharge({
          subscriptionId: atualizada.id,
          companyId,
          type: 'subscription',
          paymentKind: 'credit_card',
          status: 'pending',
          amountCents,
          installments: 1,
          seats,
          periodStart: inicio,
          periodEnd: addYears(inicio, 1),
          metadata: { method: 'annual_card', intent: 'plan_annual_card' },
        }));

      const sessao = await this.checkout.abrir(charge, atualizada, 'plan_annual_card', {
        descricao: `TaskDY anual (${seats} usuário${seats > 1 ? 's' : ''})`,
        amountCents,
        cycle: 'YEARLY',
        // A âncora do R47, não "hoje": quem renova antes de vencer não pode ter o
        // segundo ano cobrado cedo demais.
        nextDueDate: inicio,
      });

      await this.repo.updateSubscription(atualizada.id, {
        method: 'annual_card',
        purchasedSeats: seats,
      });

      this.logger.info(
        { companyId, subscriptionId: atualizada.id, chargeId: charge.id, seats },
        'Checkout do plano anual (cartão) aberto',
      );
      return { ...sessao, status: await this.getStatus(companyId) };
    });
  }

  // ── Assentos ───────────────────────────────────────────────────────────────

  /**
   * Bloqueia a ocupação de um novo assento quando todos os comprados já estão
   * ocupados. Pulado para trial/courtesy (acesso total) e com billing desligado.
   */
  async assertSeatAvailable(companyId: string): Promise<void> {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') return;
    const sub = await this.repo.findSubscriptionByCompany(companyId);
    if (!sub) return;
    // Cortesia é isenção de verdade (concedida pelo superadmin). Trial NÃO é: o teste
    // dá acesso ao produto, não assentos de graça — quem passa do assento incluído
    // teria gente usando sem nunca ser cobrada (C14).
    if (sub.status === 'courtesy') return;

    // Plano + assentos avulsos do anual: quem comprou um add-on tem direito a ele
    // mesmo ele não estando no valor da recorrência.
    const total = entitledSeats(sub);
    const occupied = await this.repo.countOccupiedSeats(companyId);
    if (occupied < total) return;

    // `code` no corpo, como o gate de cobrança faz com COMPANY_BLOCKED: a saída
    // desta mensagem é sempre a mesma tela (planos), e o front precisa reconhecer o
    // caso para oferecer o caminho — comparar o texto da mensagem seria um contrato
    // que quebra na primeira revisão de copy.
    throw new BadRequestException({
      code: 'SEAT_LIMIT',
      message:
        sub.status === 'trial'
          ? `O teste inclui ${total} usuário(s), todos em uso. Assine um plano para adicionar mais pessoas.`
          : `Todos os ${total} usuário(s) contratados estão em uso. Contrate mais usuários para adicionar membros.`,
    });
  }

  /**
   * Serializa por empresa uma admissão que não cabe em `ensureCompanySeat` — os casos
   * em que ocupar o assento e criar o resto (o usuário, o consumo do convite) precisa
   * ser um passo só. Sem isto, `assertSeatAvailable` é read-then-write e dois pedidos
   * simultâneos com um assento livre passam os dois.
   *
   * Mantenha só a seção crítica aqui dentro: o lock é de transação, e segurar uma
   * transação Postgres enquanto se manda e-mail é o jeito de transformar lentidão do
   * Resend em contenção de banco.
   */
  withSeatLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    return this.repo.withCompanyLock(companyId, fn);
  }

  /**
   * Porta única para alguém passar a ocupar um assento da empresa. Quem já é membro
   * não consome assento novo — a chamada é no-op —, então promover, mudar de papel ou
   * entrar num segundo workspace nunca esbarra no limite. Só a entrada de gente nova
   * passa por `assertSeatAvailable`.
   *
   * Existe porque a checagem estava só na porta de "contratar/convidar": os fluxos de
   * workspace criavam o vínculo de empresa direto, e adicionar alguém a um workspace
   * era um jeito de ocupar assento sem passar por cobrança.
   *
   * Serializa por empresa: `assertSeatAvailable` é read-then-write e, sem exclusão
   * mútua, dois pedidos simultâneos com um assento livre criam dois vínculos.
   */
  async ensureCompanySeat(
    companyId: string,
    userId: string,
    role: MembershipRole = 'member',
  ): Promise<void> {
    await this.repo.withCompanyLock(companyId, async () => {
      if (await this.repo.findCompanyMembership(companyId, userId)) return;
      await this.assertSeatAvailable(companyId);
      await this.repo.createCompanyMembership(companyId, userId, role);
      this.logger.info({ companyId, userId, role }, 'Assento ocupado');
    });
  }

  /**
   * Compra `quantity` assentos, **sempre por valor cheio** — o dia do mês em que a
   * compra acontece não muda o preço. O que muda é o formato, por plano:
   *
   * - **Mensal:** cobrança avulsa de `quantity × R$19,90`. Paga, o assento entra na
   *   hora e o valor da recorrência sobe para valer **da próxima cobrança em diante**;
   *   o ciclo já pago não é mexido.
   * - **Anual:** cada compra vira uma **assinatura anual própria** no Asaas
   *   (`quantity × R$179,10/ano`), com data de renovação própria. É o preço de poder
   *   comprar assento no meio de um ano já pago sem cobrar proporcional nem antecipar
   *   a renovação do plano.
   *
   * Nos dois casos o assento só vale **depois do pagamento**: liberar antes é a forma
   * mais fácil de dar acesso de graça.
   */
  async buySeats(companyId: string, dto: BuySeatsDto) {
    this.assertBillingEnabled();
    return this.repo.withCompanyLock(companyId, async () => {
      const sub = await this.getSubscriptionOrThrow(companyId);
      if (!sub.method || !sub.asaasCustomerId) {
        throw new BadRequestException('Assine um plano antes de contratar usuários');
      }
      this.assertPerfilCompleto(sub);
      // Só quem tem ciclo vigente compra assento (C3): sem isto, uma empresa vencida
      // ou bloqueada geraria cobrança por um ciclo que não existe mais.
      if (sub.status !== 'active') {
        throw new BadRequestException(
          'Regularize a assinatura antes de contratar usuários adicionais',
        );
      }
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd <= new Date()) {
        throw new BadRequestException('Ciclo de cobrança vencido ou ainda não definido');
      }

      const paymentKind = dto.paymentKind ?? 'credit_card';
      return isMonthly(sub.method)
        ? this.buySeatsOnMonthly(sub, companyId, dto.quantity, paymentKind)
        : this.buySeatsOnAnnual(sub, companyId, dto.quantity, paymentKind);
    });
  }

  /**
   * Mensal: cobrança avulsa de valor cheio. `purchasedSeats` **não** muda aqui — quem
   * mexe nele é o webhook, quando o pagamento entra. É também lá que a recorrência do
   * Asaas é reajustada, para o assento novo entrar na mensalidade do mês seguinte.
   */
  private async buySeatsOnMonthly(
    sub: Subscription,
    companyId: string,
    quantity: number,
    paymentKind: 'pix' | 'credit_card',
  ) {
    const amountCents = monthlySeatChargeCents(quantity);
    const charge = await this.abrirCobrancaDeAssento(sub, companyId, {
      quantity,
      amountCents,
      paymentKind,
    });

    const descricao = `TaskDY — ${quantity} usuário${quantity > 1 ? 's' : ''}`;
    if (paymentKind === 'pix') {
      await this.emitirPix(charge, sub.asaasCustomerId!, amountCents, companyId, descricao);
      this.logger.info(
        { companyId, quantity, chargeId: charge.id, amountCents },
        'Cobrança avulsa de assentos (Pix) emitida no mensal',
      );
      return { checkoutUrl: null, status: await this.getStatus(companyId) };
    }

    const sessao = await this.checkout.abrir(charge, sub, 'seat_monthly', {
      descricao,
      amountCents,
    });
    this.logger.info(
      { companyId, quantity, chargeId: charge.id, amountCents },
      'Checkout de assentos aberto no mensal',
    );
    return { ...sessao, status: await this.getStatus(companyId) };
  }

  /**
   * Anual: uma assinatura YEARLY nova por compra. No Pix criamos a assinatura já
   * (precisamos do QR); no cartão quem a cria é o checkout, e o `asaasSubscriptionId`
   * chega pelo webhook.
   */
  private async buySeatsOnAnnual(
    sub: Subscription,
    companyId: string,
    quantity: number,
    paymentKind: 'pix' | 'credit_card',
  ) {
    const amountCents = annualSeatChargeCents(quantity);
    const addon = await this.repo.createSeatAddon({
      companyId,
      subscriptionId: sub.id,
      seats: quantity,
      unitPriceCents: ANNUAL_SEAT_CENTS,
      amountCents,
      paymentKind,
      status: 'pending',
    });

    const charge = await this.abrirCobrancaDeAssento(sub, companyId, {
      quantity,
      amountCents,
      paymentKind,
      seatAddonId: addon.id,
    });

    const descricao = `TaskDY — ${quantity} usuário${quantity > 1 ? 's' : ''}/ano`;
    if (paymentKind === 'pix') {
      const asaasSub = await this.asaas.createSubscription({
        customer: sub.asaasCustomerId!,
        billingType: 'PIX',
        value: annualSeatValueReais(quantity),
        cycle: 'YEARLY',
        nextDueDate: this.today(),
        externalReference: externalReference(addon.id),
        description: descricao,
      });
      await this.repo.updateSeatAddon(addon.id, { asaasSubscriptionId: asaasSub.id });
      await this.anexarPixDaAssinatura(charge, asaasSub.id, companyId);
      this.logger.info(
        { companyId, quantity, addonId: addon.id, asaasSubscriptionId: asaasSub.id },
        'Assinatura anual de assentos (Pix) criada',
      );
      return { checkoutUrl: null, status: await this.getStatus(companyId) };
    }

    const sessao = await this.checkout.abrir(charge, sub, 'seat_annual', {
      descricao,
      amountCents,
      cycle: 'YEARLY',
      nextDueDate: new Date(),
    });
    this.logger.info(
      { companyId, quantity, addonId: addon.id, chargeId: charge.id },
      'Checkout da assinatura anual de assentos aberto',
    );
    return { ...sessao, status: await this.getStatus(companyId) };
  }

  /**
   * Cria a cobrança pendente da compra de assentos, recusando se já houver uma aberta.
   *
   * Uma compra de assento aberta por vez (B2): trocar a forma de pagamento é ato
   * explícito do admin (`cancelPendingSeatCharge`), porque cancelar por conta própria
   * uma cobrança que o cliente pode ter acabado de pagar é como o assento sai de graça.
   */
  private async abrirCobrancaDeAssento(
    sub: Subscription,
    companyId: string,
    dados: {
      quantity: number;
      amountCents: number;
      paymentKind: 'pix' | 'credit_card';
      seatAddonId?: string;
    },
  ): Promise<BillingCharge> {
    const aberta = await this.repo.findOpenChargeByIntent(sub.id, 'seat');
    if (aberta) {
      throw new ConflictException(
        'Já existe uma cobrança de usuários aguardando pagamento. Pague-a ou cancele-a para escolher outra forma de pagamento.',
      );
    }
    const now = new Date();
    return this.repo.createCharge({
      subscriptionId: sub.id,
      companyId,
      seatAddonId: dados.seatAddonId ?? null,
      type: 'seat',
      paymentKind: dados.paymentKind,
      status: 'pending',
      amountCents: dados.amountCents,
      installments: 1,
      seats: sub.purchasedSeats + sub.addonSeats + dados.quantity,
      seatsDelta: dados.quantity,
      periodStart: now,
      periodEnd: isMonthly(sub.method) ? sub.currentPeriodEnd : addYears(now, 1),
      metadata: { method: sub.method, paymentKind: dados.paymentKind },
    });
  }

  /**
   * Cancela a cobrança de assento em aberto para o admin trocar a forma de pagamento
   * (R46). **O Asaas é a autoridade**: se lá o pagamento já consta pago, não cancelamos
   * nada — conciliamos (o assento entra) e avisamos. É o que impede matar um Pix
   * recém-pago para abrir outra cobrança do mesmo assento.
   */
  async cancelPendingSeatCharge(companyId: string) {
    this.assertBillingEnabled();
    const sub = await this.getSubscriptionOrThrow(companyId);
    const aberta = await this.repo.findOpenChargeByIntent(sub.id, 'seat');
    if (!aberta) throw new NotFoundException('Não há cobrança de usuários em aberto');

    if (aberta.asaasPaymentId) {
      const pago = await this.isPaidAtAsaas(aberta.asaasPaymentId);
      if (pago) {
        await this.webhook.reconcilePayment(aberta.asaasPaymentId);
        throw new ConflictException(
          'Esta cobrança já foi paga — os assentos foram liberados. Atualize a página.',
        );
      }
    }

    await this.cancelOpenCharge(aberta);
    // Assinatura anual de assentos que nunca foi paga morre junto: deixá-la viva
    // cobraria o cliente todo ano por assentos que ele desistiu de comprar.
    await this.descartarAddonPendente(aberta);
    this.logger.info(
      { companyId, chargeId: aberta.id },
      'Cobrança de assentos cancelada a pedido do admin',
    );
    return this.getStatus(companyId);
  }

  /**
   * Encerra a assinatura de assentos anual que ficou para trás quando a cobrança dela
   * é cancelada ou expira. Best-effort no Asaas; localmente o add-on vira `canceled`
   * para nunca contar como assento.
   */
  async descartarAddonPendente(charge: BillingCharge): Promise<void> {
    if (!charge.seatAddonId) return;
    const addon = await this.repo.findSeatAddonById(charge.seatAddonId);
    if (!addon || addon.status !== 'pending') return;

    if (addon.asaasSubscriptionId) {
      try {
        await this.asaas.deleteSubscription(addon.asaasSubscriptionId);
      } catch (err: unknown) {
        this.logger.warn(
          { addonId: addon.id, asaasSubscriptionId: addon.asaasSubscriptionId, err },
          'Falha ao encerrar a assinatura de assentos no Asaas',
        );
      }
    }
    await this.repo.updateSeatAddon(addon.id, { status: 'canceled', canceledAt: new Date() });
  }

  /** `true` só quando o Asaas confirma o pagamento; erro de rede vira "não sei" = não cancela. */
  private async isPaidAtAsaas(paymentId: string): Promise<boolean> {
    try {
      const payment = await this.asaas.getPayment(paymentId);
      return PAID_ASAAS_STATUSES.has(payment.status);
    } catch (err: unknown) {
      this.logger.warn({ paymentId, err }, 'Falha ao consultar o pagamento no Asaas');
      throw new ServiceUnavailableException(
        'Não foi possível confirmar a situação da cobrança agora. Tente de novo em instantes.',
      );
    }
  }

  /**
   * Reduz assentos do plano — vale na **próxima renovação**, sem reembolso. O mês
   * vigente já foi pago e continua valendo até o fim.
   *
   * **Só existe no mensal-cartão**: é o único plano com recorrência para reajustar. No
   * anual os assentos extras são assinaturas próprias com data própria; reduzir ali
   * significaria estornar um ano já pago, e a regra do produto é não estornar.
   *
   * Quando a redução mexe em assentos **ocupados**, o admin diz **quem sai**
   * (`userIds`): essas pessoas seguem trabalhando até o fim do ciclo já pago e
   * perdem o acesso na renovação, junto com a queda do valor. Assentos vagos são
   * devolvidos sem tocar em ninguém.
   */
  async reduceSeats(companyId: string, dto: ReduceSeatsDto) {
    this.assertBillingEnabled();
    return this.repo.withCompanyLock(companyId, async () => {
      const sub = await this.getSubscriptionOrThrow(companyId);
      if (!isMonthly(sub.method)) {
        throw new BadRequestException('Reduzir usuários só está disponível no plano mensal');
      }
      // Agendar redução só faz sentido havendo próxima renovação (C3).
      if (sub.status !== 'active' && sub.status !== 'past_due') {
        throw new BadRequestException('Não há assinatura vigente para reduzir usuários');
      }

      const userIds = [...new Set(dto.userIds ?? [])];
      const newTotal = sub.purchasedSeats - dto.quantity;
      if (newTotal < 1) {
        throw new BadRequestException('A empresa precisa de ao menos 1 usuário');
      }
      if (userIds.length > dto.quantity) {
        throw new BadRequestException(
          `Você está removendo ${dto.quantity} assento(s), mas selecionou ${userIds.length} pessoa(s)`,
        );
      }

      const holders = await this.repo.findCompanySeatHolders(companyId);
      const known = new Set(holders.map((h) => h.userId));
      const desconhecido = userIds.find((id) => !known.has(id));
      if (desconhecido) {
        throw new BadRequestException('Selecione apenas membros desta empresa');
      }
      // Quem fica depois das saídas agendadas precisa caber nos assentos restantes —
      // e "restantes" inclui os avulsos do anual, que não são tocados por esta redução.
      // Comparar só com os assentos do plano impediria de reduzir uma empresa cujo time
      // cabe justamente por causa dos avulsos que ela já pagou.
      const disponiveisDepois = newTotal + sub.addonSeats;
      const ocupadosDepois = holders.length - userIds.length;
      if (disponiveisDepois < ocupadosDepois) {
        const faltam = ocupadosDepois - disponiveisDepois;
        throw new BadRequestException(
          `Sobram ${ocupadosDepois} pessoa(s) para ${disponiveisDepois} assento(s). Selecione mais ${faltam} pessoa(s) para sair na renovação.`,
        );
      }
      // A empresa não pode ficar sem administrador.
      const adminsSaindo = holders.filter(
        (h) => h.role === 'admin' && userIds.includes(h.userId),
      ).length;
      const adminsTotal = holders.filter((h) => h.role === 'admin').length;
      if (adminsTotal > 0 && adminsSaindo >= adminsTotal) {
        throw new BadRequestException('A empresa precisa manter ao menos um administrador');
      }

      await this.repo.updateSubscription(sub.id, { seatsAtNextRenewal: newTotal });
      await this.repo.scheduleSeatRemovals(companyId, userIds, sub.currentPeriodEnd ?? new Date());
      // O valor da recorrência cai já, mas com `updatePendingPayments: false`: a
      // cobrança do ciclo corrente (que a empresa está usando com os assentos atuais)
      // não é mexida. A queda vale da próxima em diante.
      await this.syncMonthlyValue({ ...sub, seatsAtNextRenewal: newTotal }, companyId);
      this.logger.info(
        { companyId, newTotal, saindo: userIds.length },
        'Redução de assentos agendada para a renovação',
      );
      return this.getStatus(companyId);
    });
  }

  /**
   * Exportação do acervo da empresa. Disponível **mesmo com a empresa bloqueada**
   * (R42): a cobrança suspende o serviço, não o direito do cliente aos dados dele.
   * `formato: 'csv'` devolve a lista plana de tasks para abrir em planilha.
   */
  async exportCompany(companyId: string, formato: 'json' | 'csv') {
    const dados = await this.repo.exportCompanyData(companyId);
    if (!dados) throw new NotFoundException('Empresa não encontrada');

    const carimbo = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
    const nomeBase = `taskdy-${dados.legalName.replace(/[^\w-]+/g, '-').toLowerCase()}-${carimbo}`;

    if (formato === 'csv') {
      return { filename: `${nomeBase}.csv`, mime: 'text/csv; charset=utf-8', body: toCsv(dados) };
    }
    return {
      filename: `${nomeBase}.json`,
      mime: 'application/json; charset=utf-8',
      body: JSON.stringify({ exportadoEm: new Date().toISOString(), empresa: dados }, null, 2),
    };
  }

  /** Membros da empresa + quem já está marcado para sair (tela de reduzir assentos). */
  getSeatHolders(companyId: string) {
    return this.repo.findCompanySeatHolders(companyId);
  }

  /**
   * O extrato da mudança **antes** de confirmar — a tela existe para responder duas
   * perguntas, "quando eu pago" e "quanto": no mensal, nada agora e a próxima fatura
   * aberta item a item; no anual, o valor de hoje na forma de pagamento escolhida
   * (com juros e parcelas, se for cartão) e o preço da renovação.
   *
   * Todos os números saem das MESMAS funções que cobram — rótulo e dinheiro calculados
   * em lugares diferentes divergem (era o "13 mês(es)" de um ano, C18).
   */
  async previewSeatChange(companyId: string, quantity: number, query: SeatPreviewQueryDto) {
    const { acao } = query;
    const sub = await this.getSubscriptionOrThrow(companyId);
    const occupied = await this.repo.countOccupiedSeats(companyId);
    const now = new Date();
    const comprando = acao === 'comprar';
    const totalAtual = entitledSeats(sub);
    const seatsDepois = comprando
      ? totalAtual + quantity
      : Math.max(1, sub.purchasedSeats - quantity) + sub.addonSeats;

    const anual = isAnnual(sub.method);
    const cicloVivo = !!sub.currentPeriodEnd && sub.currentPeriodEnd > now;
    const planoDepois = comprando
      ? sub.purchasedSeats + (anual ? 0 : quantity)
      : Math.max(1, sub.purchasedSeats - quantity);
    const valorHoje = anual
      ? annualTotalCents(sub.purchasedSeats)
      : monthlyTotalCents(sub.purchasedSeats);
    const valorDepois = anual ? annualTotalCents(planoDepois) : monthlyTotalCents(planoDepois);
    const pagamento = query.pagamento ?? 'credit_card';

    const comum = {
      acao,
      quantity,
      method: sub.method,
      /** Cadência do plano — o front não deve misturar preço mensal com plano anual. */
      cadencia: anual ? ('anual' as const) : ('mensal' as const),
      seatsAtuais: totalAtual,
      seatsDepois,
      occupiedSeats: occupied,
      /** Quantas pessoas precisam sair para caber no novo total (0 = ninguém). */
      precisaLiberar: Math.max(0, occupied - seatsDepois),
      valorHojeCents: valorHoje,
      valorDepoisCents: valorDepois,
      /** A mudança de valor da recorrência só vale a partir daqui. */
      vigenciaEm: sub.currentPeriodEnd,
      cobrancaAberta: await this.openSeatChargeSummary(sub.id),
    };

    // Reduzir nunca cobra nem estorna: vale na renovação, e só existe no mensal.
    if (!comprando) {
      return {
        ...comum,
        disponivel: isMonthly(sub.method),
        indisponivelPorque: isMonthly(sub.method)
          ? null
          : 'Reduzir usuários só está disponível no plano mensal',
        cobrancaAgoraCents: 0,
        baseDoCalculo: null,
        proximaFatura: isMonthly(sub.method)
          ? { vencimentoEm: sub.currentPeriodEnd, mensalidadeCents: valorDepois }
          : null,
        assentoDisponivelEm: 'na_renovacao' as const,
      };
    }

    if (!cicloVivo || !sub.method) {
      return {
        ...comum,
        disponivel: false,
        indisponivelPorque: 'Regularize a assinatura antes de contratar usuários adicionais',
        cobrancaAgoraCents: 0,
        baseDoCalculo: null,
        proximaFatura: null,
        assentoDisponivelEm: 'no_pagamento' as const,
      };
    }

    // Mensal: cobrança avulsa de valor cheio agora; a mensalidade sobe da próxima.
    if (isMonthly(sub.method)) {
      const cobrancaAgoraCents = monthlySeatChargeCents(quantity);
      return {
        ...comum,
        disponivel: true,
        indisponivelPorque: null,
        cobrancaAgoraCents,
        pagamento,
        baseDoCalculo: `${quantity} × ${this.reais(MONTHLY_EXTRA_SEAT_CENTS).toFixed(2)} por usuário`,
        proximaFatura: { vencimentoEm: sub.currentPeriodEnd, mensalidadeCents: valorDepois },
        assentoDisponivelEm: 'no_pagamento' as const,
      };
    }

    // Anual: uma assinatura própria por compra, um ano cheio, renovação própria.
    const cobrancaAgoraCents = annualSeatChargeCents(quantity);
    return {
      ...comum,
      disponivel: true,
      indisponivelPorque: null,
      cobrancaAgoraCents,
      pagamento,
      baseDoCalculo: `${quantity} × ${this.reais(ANNUAL_SEAT_CENTS).toFixed(2)} por usuário/ano`,
      proximaFatura: null,
      /**
       * Assento anual vira assinatura separada: renova na data da compra, não na do
       * plano. A tela precisa dizer isso — é a parte contraintuitiva da regra.
       */
      renovacaoPropriaEm: addYears(now, 1),
      assentoDisponivelEm: 'no_pagamento' as const,
    };
  }

  /** Cobrança de assento em aberto — a tela precisa mostrá-la antes de oferecer outra. */
  private async openSeatChargeSummary(subscriptionId: string) {
    const aberta = await this.repo.findOpenChargeByIntent(subscriptionId, 'seat');
    if (!aberta) return null;
    return {
      id: aberta.id,
      amountCents: aberta.amountCents,
      paymentKind: aberta.paymentKind,
      seatsDelta: aberta.seatsDelta,
      invoiceUrl: aberta.invoiceUrl,
      checkoutUrl: this.checkoutVivo(aberta) ? aberta.checkoutUrl : null,
      pixExpiresAt: aberta.pixExpiresAt,
      createdAt: aberta.createdAt,
    };
  }

  /**
   * Aumento de assentos feito **pelo superadmin**, cobrado do mesmo jeito que a
   * empresa pagaria sozinha (C14 — assento concedido por dentro não pode sair de graça).
   *
   * Sai sempre em **Pix**: por dentro não temos como levar o cliente ao checkout do
   * Asaas nem debitar um cartão que não guardamos. O assento entra quando o Pix for
   * pago, como em qualquer compra.
   */
  async chargeSeatsAdjustedBySuperadmin(
    companyId: string,
    quantity: number,
    origem: string,
  ): Promise<BillingCharge | null> {
    this.assertBillingEnabled();
    return this.repo.withCompanyLock(companyId, async () => {
      const sub = await this.getSubscriptionOrThrow(companyId);
      if (!sub.method || !sub.asaasCustomerId) {
        throw new BadRequestException('A empresa precisa ter um plano assinado');
      }
      if (sub.status !== 'active') {
        throw new BadRequestException('A assinatura precisa estar vigente');
      }
      const now = new Date();
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd <= now) {
        throw new BadRequestException('Ciclo de cobrança vencido ou ainda não definido');
      }

      const resultado = isMonthly(sub.method)
        ? await this.buySeatsOnMonthly(sub, companyId, quantity, 'pix')
        : await this.buySeatsOnAnnual(sub, companyId, quantity, 'pix');
      void resultado;

      const charge = await this.repo.findOpenChargeByIntent(sub.id, 'seat');
      this.logger.info(
        { companyId, quantity, chargeId: charge?.id, origem, method: sub.method },
        'Superadmin gerou cobrança de assentos (Pix, valor cheio)',
      );
      return charge;
    });
  }

  /** Cria o pagamento Pix de uma cobrança, grava o QR e avisa os admins. */
  private async emitirPix(
    charge: BillingCharge,
    customerId: string,
    amountCents: number,
    companyId: string,
    description: string,
  ): Promise<void> {
    const payment = await this.payCharge(charge, {
      customer: customerId,
      billingType: 'PIX',
      value: this.reais(amountCents),
      dueDate: this.today(),
      externalReference: externalReference(charge.id),
      description,
    });
    const qr = await this.asaas.getPixQrCode(payment.id);
    const expiresAt = this.parseAsaasDate(qr.expirationDate);
    await this.repo.updateCharge(charge.id, {
      pixPayload: qr.payload,
      pixEncodedImage: qr.encodedImage,
      pixExpiresAt: expiresAt,
    });
    // O assento só libera quando esse Pix for pago (R18) — avisa por e-mail. Best-effort.
    try {
      const to = await this.repo.findCompanyAdminEmails(companyId);
      await this.mailer.sendSeatPixEmail(to, companyId, qr.payload, expiresAt);
    } catch (err: unknown) {
      this.logger.warn(
        { companyId, chargeId: charge.id, err },
        'Falha ao enviar e-mail do Pix de assento',
      );
    }
  }

  /**
   * Põe o valor da recorrência mensal em dia com os assentos.
   *
   * Só mexe nas cobranças **futuras** (`updatePendingPayments: false`): a cobrança do
   * ciclo corrente é do mês que a empresa está usando com os assentos antigos, e o
   * assento novo já foi pago à parte, cheio. Mexer nela seria cobrar duas vezes.
   *
   * O valor é **absoluto**, nunca incremental: reexecutar (retry, cron, duas compras
   * seguidas) converge para o mesmo número. Best-effort — falar com o Asaas pode
   * falhar, e a compra não deve cair por causa disso; o cron reexecuta.
   */
  async syncMonthlyValue(sub: Subscription, companyId: string): Promise<void> {
    if (!isMonthly(sub.method) || !sub.asaasSubscriptionId) return;
    const seats = sub.seatsAtNextRenewal ?? sub.purchasedSeats;
    try {
      await this.asaas.updateSubscriptionValue(sub.asaasSubscriptionId, monthlyValueReais(seats));
      this.logger.info({ companyId, seats }, 'Valor da recorrência mensal atualizado no Asaas');
    } catch (err: unknown) {
      this.logger.error({ companyId, err }, 'Falha ao atualizar valor da assinatura no Asaas');
    }
  }

  // ── Cancelamento ─────────────────────────────────────────────────────────────

  /**
   * Cancelamento self-service do admin (R25/R26): agenda o cancelamento para o
   * fim do ciclo já pago. O acesso segue até `currentPeriodEnd`, quando o cron
   * (`handleCancellations`) vira `canceled` e a empresa cai em somente-leitura.
   *
   * **Quando a recorrência morre depende do ciclo.** No mensal a próxima cobrança sai
   * em até um mês — quase sempre antes do fim do ciclo pago — então ela é encerrada
   * agora. No anual a próxima está a até um ano de distância, sempre *depois* de
   * `currentPeriodEnd`: mantê-la viva é seguro e é o que permite `reactivate` ser um
   * flag-flip. Quem a derruba, no anual, é o `handleCancellations` no vencimento.
   *
   * Derrubar a recorrência anual aqui foi um bug real: `reactivate` não a recriava, e
   * a empresa voltava a `active` sem nada cobrando — ativa para sempre, de graça.
   */
  async cancel(companyId: string) {
    this.assertBillingEnabled();
    const sub = await this.getSubscriptionOrThrow(companyId);
    // `past_due` também pode cancelar (C9): é justamente quem tem uma recorrência
    // viva tentando cobrar de novo. Sem isso o cliente em carência ficava sem saída
    // — não conseguia cancelar e o Asaas seguia tentando o cartão.
    if (sub.status !== 'active' && sub.status !== 'past_due') {
      throw new BadRequestException('Só uma assinatura vigente pode ser cancelada');
    }
    // Idempotente: já agendado → só devolve o status atual.
    if (sub.cancelAtPeriodEnd) return this.getStatus(companyId);

    // `past_due` derruba agora seja qual for o ciclo: há uma fatura vencida em voo, e
    // deixar o Asaas seguir tentando cobrá-la é cobrar quem acabou de cancelar.
    const encerrarAgora = isMonthly(sub.method) || sub.status === 'past_due';
    if (encerrarAgora) await this.tearDownAsaasSubscription(sub, companyId);

    // As assinaturas de assentos anuais têm vida própria no Asaas e renovariam sozinhas
    // depois de a empresa cancelar. Cancelar o plano tem que levá-las junto — senão o
    // cliente cancela e continua sendo cobrado todo ano por assentos que não usa.
    await this.cancelarAddonsDaEmpresa(companyId, 'cancelamento do plano');
    await this.repo.updateSubscription(sub.id, {
      cancelAtPeriodEnd: true,
      ...(encerrarAgora ? { asaasSubscriptionId: null } : {}),
    });
    this.logger.info(
      { companyId, subscriptionId: sub.id, currentPeriodEnd: sub.currentPeriodEnd },
      'Assinatura agendada para cancelar no fim do ciclo',
    );
    return this.getStatus(companyId);
  }

  /**
   * Encerra todas as assinaturas de assentos anuais da empresa (Asaas + local) e zera
   * o contador. Público porque o cron e o superadmin precisam do mesmo caminho.
   */
  async cancelarAddonsDaEmpresa(companyId: string, motivo: string): Promise<void> {
    const addons = await this.repo.findSeatAddons(companyId, ['pending', 'active', 'past_due']);
    if (addons.length === 0) return;

    for (const addon of addons) {
      if (addon.asaasSubscriptionId) {
        try {
          await this.asaas.deleteSubscription(addon.asaasSubscriptionId);
        } catch (err: unknown) {
          this.logger.error(
            { companyId, addonId: addon.id, asaasSubscriptionId: addon.asaasSubscriptionId, err },
            'Falha ao encerrar assinatura de assentos no Asaas',
          );
        }
      }
      await this.repo.updateSeatAddon(addon.id, { status: 'canceled', canceledAt: new Date() });
    }

    const sub = await this.repo.findSubscriptionByCompany(companyId);
    if (sub) await this.repo.syncAddonSeats(sub.id, companyId);
    this.logger.info(
      { companyId, quantidade: addons.length, motivo },
      'Assinaturas de assentos adicionais encerradas',
    );
  }

  /** Encerra a assinatura recorrente no Asaas (best-effort — não quebra o cancelamento). */
  private async tearDownAsaasSubscription(sub: Subscription, companyId: string): Promise<void> {
    if (!sub.asaasSubscriptionId) return;
    try {
      await this.asaas.deleteSubscription(sub.asaasSubscriptionId);
    } catch (err: unknown) {
      this.logger.error(
        { companyId, asaasSubscriptionId: sub.asaasSubscriptionId, err },
        'Falha ao encerrar a assinatura no Asaas (cancelamento segue agendado)',
      );
    }
  }

  /**
   * Desfaz um cancelamento agendado: a assinatura ainda está `active` com
   * `cancelAtPeriodEnd = true`.
   *
   * O critério é **ter ou não recorrência viva no Asaas**, não o método. No anual
   * `cancel` a deixou de pé de propósito, então basta limpar o flag. Quando ela foi
   * derrubada — o mensal sempre, e qualquer plano cancelado em carência — reativar
   * significa **abrir um checkout novo**, que recria a recorrência cobrando só a partir
   * do fim do período já pago. A resposta traz o link.
   *
   * Decidir isso pelo método era o bug: um anual sem recorrência caía no flag-flip e a
   * empresa voltava a `active` sem nada cobrando.
   */
  async reactivate(companyId: string) {
    this.assertBillingEnabled();
    const sub = await this.getSubscriptionOrThrow(companyId);
    if (sub.status !== 'active' || !sub.cancelAtPeriodEnd) {
      throw new BadRequestException('Não há cancelamento agendado para reativar');
    }

    const noCartao = isCard(sub.method);
    if (noCartao && !sub.asaasSubscriptionId) {
      this.assertPerfilCompleto(sub);
      if (!sub.asaasCustomerId || !sub.currentPeriodEnd) {
        throw new BadRequestException(
          'Não foi possível reativar automaticamente; assine o plano novamente',
        );
      }
      const sessao = await this.abrirCheckoutDaRecorrencia(sub, companyId, 'reativacao');
      await this.repo.updateSubscription(sub.id, { cancelAtPeriodEnd: false });
      this.logger.info(
        { companyId, subscriptionId: sub.id },
        'Reativação: checkout aberto para recriar a recorrência',
      );
      return { ...sessao, status: await this.getStatus(companyId) };
    }

    await this.repo.updateSubscription(sub.id, { cancelAtPeriodEnd: false });
    this.logger.info(
      { companyId, subscriptionId: sub.id, method: sub.method },
      'Cancelamento desfeito (assinatura reativada)',
    );
    return { checkoutUrl: null, status: await this.getStatus(companyId) };
  }

  /**
   * Atualiza o perfil de cobrança — sem cartão, sem cobrança, sem tocar no plano.
   *
   * Deixou de ser um detalhe de conveniência: com o cartão sendo digitado na página do
   * Asaas, é este cadastro que aparece lá e é ele que o antifraude vê. Por isso o
   * endereço agora **é empurrado** para o cliente no Asaas (antes ia por transação, o
   * que não existe mais).
   */
  async updateBillingAddress(companyId: string, dto: UpdateBillingAddressDto) {
    const sub = await this.getSubscriptionOrThrow(companyId);
    const perfil = normalizarPerfil(dto);

    // Dados fiscais (razão social / CNPJ) vivem na Company, não na assinatura.
    const taxId = dto.taxId ? normalizeTaxId(dto.taxId) : undefined;
    if (taxId) {
      const duplicada = await this.repo.findCompanyByTaxIdExcluding(taxId, companyId);
      if (duplicada) throw new ConflictException('Já existe uma empresa com este CNPJ');
    }
    if (dto.legalName || taxId) {
      await this.repo.updateCompanyFiscal(companyId, {
        ...(dto.legalName ? { legalName: dto.legalName } : {}),
        ...(taxId ? { taxId } : {}),
      });
    }

    await this.repo.updateSubscription(sub.id, {
      billingName: perfil.name,
      billingEmail: perfil.email,
      billingCpfCnpj: perfil.cpfCnpj,
      billingPostalCode: perfil.postalCode,
      billingStreet: perfil.street,
      billingAddressNumber: perfil.addressNumber,
      billingAddressComplement: perfil.addressComplement,
      billingNeighborhood: perfil.neighborhood,
      billingCity: perfil.city,
      billingState: perfil.state,
      billingPhone: perfil.phone,
    });

    // O cadastro do cliente no Asaas é o que a página de checkout exibe. Sincronizar
    // aqui (e não na hora da compra) é o que faz o dado certo já estar lá quando o
    // cliente chegar. Best-effort — nossa gravação não pode falhar por causa do Asaas.
    if (sub.asaasCustomerId) {
      try {
        await this.asaas.updateCustomer(sub.asaasCustomerId, {
          name: dto.legalName ?? perfil.name,
          ...(taxId ? { cpfCnpj: taxId } : {}),
          ...this.dadosDoCliente(perfil),
        });
      } catch (err: unknown) {
        this.logger.warn(
          { companyId, asaasCustomerId: sub.asaasCustomerId, err },
          'Cadastro atualizado aqui, mas a sincronia com o provedor falhou',
        );
      }
    }

    this.logger.info(
      { companyId, subscriptionId: sub.id, fiscalAlterado: Boolean(dto.legalName || taxId) },
      'Dados de cobrança atualizados',
    );
    return this.getStatus(companyId);
  }

  /** Campos de contato/endereço no formato que o Asaas espera (`province` = bairro). */
  private dadosDoCliente(perfil: PerfilCobranca) {
    return {
      email: perfil.email,
      phone: perfil.phone,
      mobilePhone: perfil.phone,
      postalCode: perfil.postalCode,
      address: perfil.street,
      addressNumber: perfil.addressNumber,
      complement: perfil.addressComplement ?? undefined,
      province: perfil.neighborhood,
      city: perfil.city,
    };
  }

  /**
   * Troca o cartão da assinatura. Sem formulário: abre um checkout novo, que recria a
   * recorrência no Asaas com o cartão que o cliente digitar lá, cobrando a partir do
   * fim do ciclo já pago.
   *
   * Vale nos dois planos de cartão. No anual isso deixou de ser opcional quando ele
   * passou a renovar sozinho: o cartão fica guardado no Asaas por um ano inteiro e vai
   * expirar antes da renovação — sem esta rota, o cliente não teria como atualizá-lo.
   *
   * **Não quita a fatura em atraso** — quem faz isso é o outro botão
   * (`getFaturaEmAtraso`), que leva à página da própria cobrança. Separar os dois é o
   * que evita a confusão de "troquei o cartão mas continuo bloqueado": pagar o que
   * ficou para trás e mudar o cartão das próximas são coisas diferentes.
   */
  async trocarCartao(companyId: string) {
    this.assertBillingEnabled();
    return this.repo.withCompanyLock(companyId, async () => {
      const sub = await this.getSubscriptionOrThrow(companyId);
      if (!isCard(sub.method)) {
        throw new BadRequestException('Só as assinaturas no cartão têm cartão para atualizar');
      }
      if (sub.status !== 'active' && sub.status !== 'past_due') {
        throw new BadRequestException('Não há assinatura vigente para atualizar o cartão');
      }
      if (!sub.asaasCustomerId) {
        throw new BadRequestException('Assine um plano antes de atualizar o cartão');
      }
      this.assertPerfilCompleto(sub);

      const sessao = await this.abrirCheckoutDaRecorrencia(sub, companyId, 'troca de cartão');
      this.logger.info(
        { companyId, subscriptionId: sub.id },
        'Checkout aberto para trocar o cartão da recorrência',
      );
      return { ...sessao, status: await this.getStatus(companyId) };
    });
  }

  /**
   * Abre o checkout que (re)cria a recorrência do cartão — caminho comum de "trocar
   * cartão" e "reativar", nos dois ciclos. A recorrência antiga é derrubada antes:
   * duas recorrências vivas cobram em dobro, e o cartão novo só existe do lado do
   * Asaas.
   *
   * A cobrança nasce com `nextDueDate` no fim do ciclo já pago — trocar o cartão não
   * antecipa a renovação nem cobra de novo o período que o cliente já pagou.
   */
  private async abrirCheckoutDaRecorrencia(
    sub: Subscription,
    companyId: string,
    motivo: string,
  ): Promise<{ checkoutUrl: string; expiresAt: Date; reused: boolean }> {
    const desde = sub.currentPeriodEnd ?? new Date();
    await this.tearDownAsaasSubscription(sub, companyId);
    await this.repo.updateSubscription(sub.id, { asaasSubscriptionId: null });

    // Só é alcançável pelos métodos de cartão (`trocarCartao` e `reactivate` gateiam
    // por `isCard`), mas o método é lido do plano em vez de deduzido: coagir um método
    // desconhecido para `monthly_card` gravaria a cobrança com o plano errado.
    const method = sub.method as 'monthly_card' | 'annual_card';
    const anual = isAnnual(method);
    // Reduzir assentos só existe no mensal, então no anual `seatsAtNextRenewal` é
    // sempre nulo — a expressão serve aos dois.
    const seats = sub.seatsAtNextRenewal ?? sub.purchasedSeats;
    const amountCents = anual ? annualTotalCents(seats) : monthlyTotalCents(seats);
    const aberta = await this.settleOpenCharge(sub.id, 'subscription', method, new Date(), seats);
    const charge =
      aberta ??
      (await this.repo.createCharge({
        subscriptionId: sub.id,
        companyId,
        type: 'subscription',
        paymentKind: 'credit_card',
        status: 'pending',
        amountCents,
        installments: 1,
        seats,
        periodStart: desde,
        periodEnd: null,
        metadata: { method, intent: 'card_update', motivo },
      }));

    return this.checkout.abrir(charge, sub, 'card_update', {
      descricao: `TaskDY ${anual ? 'anual' : 'mensal'} (${seats} usuário${seats > 1 ? 's' : ''})`,
      amountCents,
      cycle: anual ? 'YEARLY' : 'MONTHLY',
      nextDueDate: desde,
    });
  }

  /**
   * Link da fatura em atraso, na página hospedada do Asaas. É o "Pagar fatura em
   * atraso": o cliente quita ali e o webhook do pagamento devolve a empresa para
   * `active` pelo caminho de sempre, sem atalho aqui.
   */
  async getFaturaEmAtraso(companyId: string): Promise<{ invoiceUrl: string | null }> {
    const sub = await this.getSubscriptionOrThrow(companyId);
    const vencida = await this.findOverdueInvoice(sub);
    if (vencida?.invoiceUrl) return { invoiceUrl: vencida.invoiceUrl };

    // Sem recorrência (anual-cartão, ou recorrência recém-derrubada) o que existe é a
    // nossa cobrança pendente — o `invoiceUrl` dela leva à mesma página.
    const pendente = await this.repo.findLatestPendingCharge(companyId);
    return { invoiceUrl: pendente?.invoiceUrl ?? null };
  }

  /** Fatura vencida da recorrência, se houver — a que precisa ser quitada. */
  private async findOverdueInvoice(sub: Subscription): Promise<AsaasPayment | null> {
    if (!sub.asaasSubscriptionId) return null;
    try {
      const list = await this.asaas.listSubscriptionPayments(sub.asaasSubscriptionId);
      return (list.data ?? []).find((p) => p.status === 'OVERDUE') ?? null;
    } catch (err: unknown) {
      this.logger.warn({ companyId: sub.companyId, err }, 'Falha ao listar faturas da assinatura');
      return null;
    }
  }

  // ── Idempotência do checkout (B2) ──────────────────────────────────────────

  /**
   * Prepara o terreno para contratar um plano e devolve **quando o novo ciclo começa**.
   *
   * Com ciclo pago em aberto, contratar não é erro — é **renovar antes de vencer ou
   * trocar de plano** (R47): o novo ciclo começa em `currentPeriodEnd`, o atual segue
   * até lá e nada é cobrado nem estornado no meio. Antes isto era 409, e o cliente
   * anual só conseguia renovar depois de vencer e perder o acesso.
   *
   * Também limpa o que sobrou de tentativas anteriores: sem isso, dois cliques (ou um
   * retry de rede) viravam duas cobranças — no mensal, duas recorrências para sempre.
   */
  private async prepareForNewSubscription(sub: Subscription, companyId: string): Promise<Date> {
    this.assertSemCancelamentoAgendado(sub);
    const now = new Date();
    // Âncora: fim do ciclo pago (renovação/troca antecipada) ou agora (sem cobertura).
    const inicio = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;

    // Recorrência antiga sai de cena antes da nova nascer (troca de plano, retomada a
    // partir de `past_due`): duas recorrências vivas = cobrança em dobro.
    if (sub.asaasSubscriptionId) {
      await this.tearDownAsaasSubscription(sub, companyId);
      await this.repo.updateSubscription(sub.id, { asaasSubscriptionId: null });
    }
    // Assinatura NOVA não herda cancelamento antigo (C1): a flag sobrevive ao
    // cancelamento efetivado, e sem isto o cron cancelaria o plano recém-contratado
    // no fim do primeiro ciclo — cliente pagando e sendo cancelado sozinho.
    if (sub.cancelAtPeriodEnd || sub.canceledAt) {
      await this.repo.updateSubscription(sub.id, { cancelAtPeriodEnd: false, canceledAt: null });
    }
    return inicio;
  }

  /**
   * Contratar por cima de um cancelamento agendado é ambíguo (o cliente quer voltar ao
   * mesmo plano ou trocar?). O caminho é "Reativar assinatura".
   *
   * Separado do `prepareForNewSubscription` porque precisa rodar **antes** de qualquer
   * coisa destrutiva — inclusive antes de resolver a cobrança aberta.
   */
  private assertSemCancelamentoAgendado(sub: Subscription): void {
    if (sub.status === 'active' && sub.cancelAtPeriodEnd) {
      throw new ConflictException(
        'A assinatura está ativa com cancelamento agendado. Use "Reativar assinatura".',
      );
    }
  }

  /**
   * Resolve a cobrança aberta do mesmo intento: **reaproveita** se for do mesmo
   * método e ainda pagável (Pix com QR válido), senão **cancela** (no Asaas e aqui)
   * para liberar o intento. Devolve a cobrança reaproveitável, se houver.
   */
  private async settleOpenCharge(
    subscriptionId: string,
    type: ChargeType,
    method: BillingMethod,
    now: Date,
    /**
     * Assentos da nova intenção. Uma cobrança aberta por 3 assentos não serve para
     * quem agora pediu 8: devolver aquele QR cobraria o valor errado e entregaria o
     * plano menor. `undefined` mantém o comportamento antigo (não olha quantidade).
     */
    seats?: number,
  ): Promise<BillingCharge | null> {
    const open = await this.repo.findOpenChargeByIntent(subscriptionId, type);
    if (!open) return null;

    const openMethod = (open.metadata as unknown as { method?: string } | null)?.method;
    const pixUsable =
      open.pixPayload != null && open.pixExpiresAt != null && open.pixExpiresAt > now;
    const mesmaQuantidade = seats == null || open.seats === seats;
    const reusable =
      openMethod === method && mesmaQuantidade && (open.paymentKind !== 'pix' || pixUsable);

    if (reusable) {
      this.logger.info(
        { chargeId: open.id, type, method },
        'Cobrança aberta reaproveitada (nenhuma cobrança nova criada)',
      );
      return open;
    }

    await this.cancelOpenCharge(open);
    return null;
  }

  /** Cancela uma cobrança aberta aqui e no Asaas (best-effort do lado do provedor). */
  private async cancelOpenCharge(charge: BillingCharge): Promise<void> {
    if (charge.asaasPaymentId) {
      try {
        await this.asaas.deletePayment(charge.asaasPaymentId);
      } catch (err: unknown) {
        this.logger.warn(
          { chargeId: charge.id, asaasPaymentId: charge.asaasPaymentId, err },
          'Falha ao remover cobrança antiga no Asaas (segue cancelada localmente)',
        );
      }
    }
    await this.repo.updateCharge(charge.id, { status: 'canceled' });
    this.logger.info({ chargeId: charge.id }, 'Cobrança aberta anterior cancelada');
  }

  /**
   * Cria o pagamento no Asaas e **grava o id na cobrança imediatamente** (B5): se o
   * processo cair em seguida, a conciliação ainda encontra o pagamento. Falhou antes
   * de criar → a cobrança local vira `failed` (não fica pendente eternamente).
   */
  private async payCharge(charge: BillingCharge, input: CreatePaymentInput): Promise<AsaasPayment> {
    let payment: AsaasPayment;
    try {
      payment = await this.asaas.createPayment(input);
    } catch (err: unknown) {
      await this.failCharge(charge.id, err);
      throw err;
    }
    await this.repo.updateCharge(charge.id, {
      asaasPaymentId: payment.id,
      invoiceUrl: payment.invoiceUrl,
    });
    return payment;
  }

  private async failCharge(chargeId: string, err: unknown): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await this.repo.updateCharge(chargeId, {
        status: 'failed',
        failedAt: new Date(),
        failReason: reason.slice(0, 500),
      });
    } catch (updateErr: unknown) {
      this.logger.error({ chargeId, err: updateErr }, 'Falha ao marcar cobrança como falha');
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Garante o cliente no Asaas, já com o endereço completo — é ele que a página de
   * checkout exibe. Um cliente por empresa (`externalReference: taskdy:<companyId>`): é
   * essa unicidade que permite reencontrar depois a assinatura e o pagamento que o
   * checkout criar.
   *
   * O `groupName` vai nos dois caminhos de propósito: é pelo `updateCustomer` que o
   * cliente criado antes deste namespace entra no grupo, sem script de backfill.
   */
  private async ensureCustomer(sub: Subscription, companyId: string): Promise<string> {
    const fiscal = await this.repo.getCompanyFiscal(companyId);
    if (!fiscal) throw new NotFoundException('Empresa não encontrada');
    const endereco = this.enderecoDoCadastro(sub);
    const grupo = this.grupoDeClientes();

    if (sub.asaasCustomerId) {
      // Best-effort: o perfil pode ter mudado desde a criação, e o checkout mostra o
      // que estiver no Asaas. Falhar aqui não pode impedir o cliente de pagar.
      try {
        await this.asaas.updateCustomer(sub.asaasCustomerId, {
          name: fiscal.legalName,
          cpfCnpj: fiscal.taxId,
          externalReference: externalReference(companyId),
          ...(grupo ? { groupName: grupo } : {}),
          ...endereco,
        });
      } catch (err: unknown) {
        this.logger.warn(
          { companyId, asaasCustomerId: sub.asaasCustomerId, err },
          'Falha ao sincronizar o cadastro do cliente no Asaas',
        );
      }
      return sub.asaasCustomerId;
    }

    const customer = await this.asaas.createCustomer({
      name: fiscal.legalName,
      cpfCnpj: fiscal.taxId,
      email: endereco.email ?? fiscal.adminEmail,
      externalReference: externalReference(companyId),
      ...(grupo ? { groupName: grupo } : {}),
      ...endereco,
    });
    await this.repo.updateSubscription(sub.id, { asaasCustomerId: customer.id });
    return customer.id;
  }

  /** Grupo do painel do Asaas. Só afeta o painel — nunca a resolução de eventos. */
  private grupoDeClientes(): string | undefined {
    return resolveGroupName(this.config.get<string>('ASAAS_CUSTOMER_GROUP'));
  }

  /** Endereço já guardado, no formato do Asaas. Campos vazios simplesmente não vão. */
  private enderecoDoCadastro(sub: Subscription) {
    return {
      ...(sub.billingEmail ? { email: sub.billingEmail } : {}),
      ...(sub.billingPhone ? { phone: sub.billingPhone, mobilePhone: sub.billingPhone } : {}),
      ...(sub.billingPostalCode ? { postalCode: sub.billingPostalCode } : {}),
      ...(sub.billingStreet ? { address: sub.billingStreet } : {}),
      ...(sub.billingAddressNumber ? { addressNumber: sub.billingAddressNumber } : {}),
      ...(sub.billingAddressComplement ? { complement: sub.billingAddressComplement } : {}),
      ...(sub.billingNeighborhood ? { province: sub.billingNeighborhood } : {}),
      ...(sub.billingCity ? { city: sub.billingCity } : {}),
    };
  }

  private async getSubscriptionOrThrow(companyId: string): Promise<Subscription> {
    const sub = await this.repo.findSubscriptionByCompany(companyId);
    if (!sub) throw new NotFoundException('Assinatura não encontrada para esta empresa');
    return sub;
  }

  private assertBillingEnabled(): void {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('Cobrança temporariamente indisponível');
    }
  }

  /** Centavos int → reais decimais (2 casas), na borda do Asaas. */
  private reais(cents: number): number {
    return Number((cents / 100).toFixed(2));
  }

  private today(): string {
    return formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
  }

  /** "yyyy-MM-dd HH:mm:ss" (horário de Brasília) → Date. */
  private parseAsaasDate(value: string): Date {
    return new Date(value.replace(' ', 'T') + '-03:00');
  }
}
