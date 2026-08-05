import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatInTimeZone } from 'date-fns-tz';
import { addMinutes, subDays } from 'date-fns';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { BillingCharge, Subscription } from '../generated/prisma/client';
import { AsaasClient } from './asaas/asaas.client';
import type {
  AsaasChargeType,
  AsaasCycle,
  AsaasPayment,
  AsaasSubscription,
  CreateCheckoutInput,
} from './asaas/asaas.types';
import { BillingRepository } from './billing.repository';
import {
  CHECKOUT_ITEM_DESCRIPTION_MAX,
  CHECKOUT_ITEM_NAME_MAX,
  CHECKOUT_MINUTES_TO_EXPIRE,
  PAYMENT_MATCH_TOLERANCE_CENTS,
} from './billing.constants';

const TZ = 'America/Sao_Paulo';

/** Para que serve o checkout — decide `chargeTypes` e o texto que o cliente lê. */
export type CheckoutIntent =
  | 'plan_monthly'
  | 'plan_annual_card'
  | 'seat_monthly'
  | 'seat_annual'
  | 'card_update';

export interface CheckoutSession {
  checkoutUrl: string;
  expiresAt: Date;
  /** `true` quando devolvemos o link de um checkout que já existia (D10). */
  reused: boolean;
}

interface AbrirOpts {
  descricao: string;
  amountCents: number;
  /** Obrigatório nos intents recorrentes. */
  cycle?: AsaasCycle;
  /** Data da primeira cobrança da recorrência (yyyy-MM-dd é montado aqui). */
  nextDueDate?: Date;
  /** Teto de parcelas — só no `plan_annual_card`. */
  maxInstallmentCount?: number;
}

const CHARGE_TYPE_BY_INTENT: Record<CheckoutIntent, AsaasChargeType> = {
  plan_monthly: 'RECURRENT',
  plan_annual_card: 'INSTALLMENT',
  seat_monthly: 'DETACHED',
  seat_annual: 'RECURRENT',
  card_update: 'RECURRENT',
};

/**
 * Tudo que fala com o Checkout hospedado do Asaas.
 *
 * O checkout é o único caminho de cartão do produto: o cliente é mandado para uma
 * página do Asaas, digita o cartão lá e volta. Em troca de nunca tocar no PAN, herdamos
 * dois problemas que este serviço existe para resolver:
 *
 * 1. **a API não tem GET de checkout** — só criar e cancelar. Saber se foi pago passa
 *    pelo webhook `CHECKOUT_PAID` ou por procurar a cobrança que ele gerou;
 * 2. **quem cria a assinatura é o Asaas**, então o `asaasSubscriptionId` só existe
 *    depois do pagamento e precisa ser descoberto.
 *
 * A regra que atravessa os dois: **na dúvida, não vincula**. Um palpite errado aqui
 * entrega assento de graça ou credita a fatura de outra empresa.
 */
@Injectable()
export class BillingCheckoutService {
  constructor(
    private readonly asaas: AsaasClient,
    private readonly repo: BillingRepository,
    private readonly config: ConfigService,
    @InjectPinoLogger(BillingCheckoutService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Abre (ou reaproveita) o checkout de uma cobrança e devolve o link.
   *
   * Reaproveitar é a regra D10: enquanto o checkout anterior estiver vivo, o botão
   * vira "continuar pagamento". Criar um segundo checkout do mesmo intento é como o
   * cliente acaba pagando duas vezes.
   */
  async abrir(
    charge: BillingCharge,
    sub: Subscription,
    intent: CheckoutIntent,
    opts: AbrirOpts,
  ): Promise<CheckoutSession> {
    const agora = new Date();
    if (charge.checkoutUrl && charge.checkoutExpiresAt && charge.checkoutExpiresAt > agora) {
      return { checkoutUrl: charge.checkoutUrl, expiresAt: charge.checkoutExpiresAt, reused: true };
    }
    if (!sub.asaasCustomerId) {
      throw new Error('Cliente do provedor de pagamento não definido');
    }

    const input = this.montarInput(charge, sub.asaasCustomerId, intent, opts);
    const checkout = await this.asaas.createCheckout(input);
    const link = checkout.link ?? `https://asaas.com/checkoutSession/show?id=${checkout.id}`;
    const expiresAt = addMinutes(agora, CHECKOUT_MINUTES_TO_EXPIRE);

    await this.repo.updateCharge(charge.id, {
      asaasCheckoutId: checkout.id,
      checkoutUrl: link,
      checkoutExpiresAt: expiresAt,
    });
    this.logger.info(
      { companyId: charge.companyId, chargeId: charge.id, checkoutId: checkout.id, intent },
      'Checkout hospedado criado',
    );
    return { checkoutUrl: link, expiresAt, reused: false };
  }

  /**
   * Encerra o checkout no Asaas. Best-effort: o que importa localmente é a cobrança
   * sair de `pending` (quem chama cuida disso). Um checkout que sobreviva do lado de
   * lá expira sozinho em 24 h.
   */
  async cancelar(charge: BillingCharge): Promise<void> {
    if (!charge.asaasCheckoutId) return;
    try {
      await this.asaas.cancelCheckout(charge.asaasCheckoutId);
    } catch (err: unknown) {
      this.logger.warn(
        { chargeId: charge.id, checkoutId: charge.asaasCheckoutId, err },
        'Falha ao cancelar o checkout no Asaas (expira sozinho)',
      );
    }
  }

  /**
   * Descobre a assinatura que o checkout recorrente criou no Asaas.
   *
   * A ordem importa e o critério é estreito de propósito. Com os assentos anuais, uma
   * empresa passa a ter **várias** assinaturas no mesmo cliente — adotar "qualquer uma
   * ativa" trocaria o plano do cliente por um bloco de assentos. Por isso:
   * `externalReference` primeiro, valor+ciclo depois, e **nada** se sobrar ambiguidade.
   */
  async resolverAssinatura(
    charge: BillingCharge,
    sub: Subscription,
    cycle: AsaasCycle,
  ): Promise<string | null> {
    if (!sub.asaasCustomerId) return null;

    let candidatas: AsaasSubscription[];
    try {
      const lista = await this.asaas.listCustomerSubscriptions(sub.asaasCustomerId);
      candidatas = lista.data ?? [];
    } catch (err: unknown) {
      this.logger.warn(
        { companyId: charge.companyId, chargeId: charge.id, err },
        'Falha ao listar assinaturas do cliente',
      );
      return null;
    }

    const jaUsadas = await this.idsJaVinculados(charge.companyId);
    const livres = candidatas.filter(
      (s) => !jaUsadas.has(s.id) && String(s.status).toUpperCase() === 'ACTIVE',
    );

    // 1. O caminho limpo: o Asaas propagou a nossa referência.
    const porReferencia = livres.filter((s) => s.externalReference === charge.id);
    if (porReferencia.length === 1) return porReferencia[0].id;

    // 2. Sem referência, exige ciclo E valor batendo — e um candidato só.
    const esperado = this.reais(charge.amountCents);
    const porValor = livres.filter(
      (s) =>
        (s.cycle == null || s.cycle === cycle) &&
        Math.abs(Math.round((s.value ?? 0) * 100) - charge.amountCents) <=
          PAYMENT_MATCH_TOLERANCE_CENTS,
    );
    if (porValor.length === 1) return porValor[0].id;

    this.logger.warn(
      {
        companyId: charge.companyId,
        chargeId: charge.id,
        candidatas: livres.length,
        porValor: porValor.length,
        esperado,
      },
      'Assinatura do checkout não resolvida sem ambiguidade — não vinculando',
    );
    return null;
  }

  /**
   * Procura no Asaas a cobrança que corresponde a uma `BillingCharge` nossa — é o que
   * faz o "Já paguei" funcionar para pagamentos nascidos de checkout.
   *
   * Devolve `null` sempre que houver dúvida. Vincular o pagamento errado é pior do que
   * pedir para o cliente clicar de novo.
   */
  async casarPagamento(charge: BillingCharge, sub: Subscription): Promise<AsaasPayment | null> {
    if (!sub.asaasCustomerId) return null;

    // 1. Referência explícita — se o Asaas a propagou, acabou aqui.
    const porRef = await this.buscar({
      customer: sub.asaasCustomerId,
      externalReference: charge.id,
    });
    if (porRef.length === 1) return porRef[0];

    // 2. Cobranças da assinatura, quando já sabemos qual é.
    const assinatura = charge.seatAddonId
      ? (await this.repo.findSeatAddonById(charge.seatAddonId))?.asaasSubscriptionId
      : sub.asaasSubscriptionId;
    if (assinatura) {
      try {
        const { data } = await this.asaas.listSubscriptionPayments(assinatura);
        const casada = (data ?? []).find((p) => this.mesmoValor(p, charge));
        if (casada) return casada;
      } catch (err: unknown) {
        this.logger.warn({ chargeId: charge.id, err }, 'Falha ao listar cobranças da assinatura');
      }
    }

    // 3. Último recurso: cliente + valor + janela de tempo, e só se **um** candidato
    //    sobrar depois de descartar o que já pertence a outra cobrança nossa.
    const desde = formatInTimeZone(subDays(charge.createdAt, 1), TZ, 'yyyy-MM-dd');
    const doCliente = await this.buscar({ customer: sub.asaasCustomerId, dateCreatedGe: desde });
    const candidatos: AsaasPayment[] = [];
    for (const p of doCliente) {
      if (!this.mesmoValor(p, charge)) continue;
      const dona = await this.repo.findChargeByAsaasPaymentId(p.id);
      if (dona && dona.id !== charge.id) continue;
      candidatos.push(p);
    }
    if (candidatos.length === 1) return candidatos[0];

    if (candidatos.length > 1) {
      this.logger.warn(
        { companyId: charge.companyId, chargeId: charge.id, candidatos: candidatos.length },
        'Mais de uma cobrança do Asaas casa com a compra — não vinculando',
      );
    }
    return null;
  }

  // ── internos ───────────────────────────────────────────────────────────────

  private montarInput(
    charge: BillingCharge,
    customerId: string,
    intent: CheckoutIntent,
    opts: AbrirOpts,
  ): CreateCheckoutInput {
    const chargeType = CHARGE_TYPE_BY_INTENT[intent];
    const base: CreateCheckoutInput = {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: [chargeType],
      minutesToExpire: CHECKOUT_MINUTES_TO_EXPIRE,
      callback: this.callbacks(charge.companyId),
      items: [
        {
          name: this.corta(opts.descricao, CHECKOUT_ITEM_NAME_MAX),
          quantity: 1,
          value: this.reais(opts.amountCents),
          description: this.corta(opts.descricao, CHECKOUT_ITEM_DESCRIPTION_MAX),
          externalReference: charge.id,
        },
      ],
      // Sempre o id do cliente, nunca `customerData`: a API recusa os dois juntos, e é
      // pelo cliente que reencontramos o que o checkout gerar.
      customer: customerId,
      externalReference: charge.id,
    };

    if (chargeType === 'RECURRENT') {
      base.subscription = {
        cycle: opts.cycle ?? 'MONTHLY',
        nextDueDate: formatInTimeZone(opts.nextDueDate ?? new Date(), TZ, 'yyyy-MM-dd'),
      };
    }
    if (chargeType === 'INSTALLMENT') {
      base.installment = { maxInstallmentCount: opts.maxInstallmentCount ?? 1 };
    }
    return base;
  }

  private callbacks(companyId: string) {
    const base = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const destino = `${base.replace(/\/$/, '')}/empresa/${companyId}/cobranca`;
    return {
      successUrl: `${destino}?checkout=sucesso`,
      cancelUrl: `${destino}?checkout=cancelado`,
      expiredUrl: `${destino}?checkout=expirado`,
    };
  }

  /** Ids de assinatura do Asaas que já pertencem a algo nosso — não podem ser adotados. */
  private async idsJaVinculados(companyId: string): Promise<Set<string>> {
    const sub = await this.repo.findSubscriptionByCompany(companyId);
    const addons = await this.repo.findSeatAddons(companyId);
    const ids = new Set<string>();
    if (sub?.asaasSubscriptionId) ids.add(sub.asaasSubscriptionId);
    for (const a of addons) if (a.asaasSubscriptionId) ids.add(a.asaasSubscriptionId);
    return ids;
  }

  private async buscar(query: Parameters<AsaasClient['listPayments']>[0]): Promise<AsaasPayment[]> {
    try {
      const { data } = await this.asaas.listPayments(query);
      return data ?? [];
    } catch (err: unknown) {
      this.logger.warn({ query, err }, 'Falha ao listar cobranças no Asaas');
      return [];
    }
  }

  private mesmoValor(payment: AsaasPayment, charge: BillingCharge): boolean {
    return (
      Math.abs(Math.round((payment.value ?? 0) * 100) - charge.amountCents) <=
      PAYMENT_MATCH_TOLERANCE_CENTS
    );
  }

  private corta(texto: string, max: number): string {
    return texto.length <= max ? texto : `${texto.slice(0, max - 1)}…`;
  }

  private reais(cents: number): number {
    return Number((cents / 100).toFixed(2));
  }
}
