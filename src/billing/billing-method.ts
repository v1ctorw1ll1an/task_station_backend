/**
 * Os dois eixos de uma forma de pagamento — funções puras, sem dependência de Nest.
 *
 * `BillingMethod` mistura **cadência** (mensal/anual) com **forma** (cartão/Pix), e o
 * código lia `method === 'monthly_card'` para perguntar as duas coisas. Enquanto o
 * mensal só existia no cartão isso funcionava por acidente; com `monthly_pix` cada um
 * desses testes vira um bug silencioso — assento cobrado como anual, recorrência nunca
 * reajustada, cancelamento que não derruba a cobrança do mês seguinte.
 *
 * A tabela abaixo é a fonte única. Sendo um `Record<BillingMethod, …>`, adicionar um
 * método novo ao enum **quebra o compilador aqui** em vez de cair calado num `else`
 * — é o ponto do desenho, e `billing-method.spec.ts` o trava.
 *
 * Segue o padrão que `CHARGE_TYPE_BY_INTENT` já usa em `billing-checkout.service.ts`.
 */
import type { BillingMethod, PaymentKind } from '../generated/prisma/client';
import type { AsaasCycle } from './asaas/asaas.types';

export type Cadence = 'monthly' | 'annual';

interface MethodTraits {
  /** Decide período do ciclo, preço e se a compra de assento é avulsa ou add-on anual. */
  cadence: Cadence;
  /** Como o dinheiro entra. Nunca derive isto do método na mão. */
  paymentKind: PaymentKind;
  /** Ciclo da assinatura no Asaas. */
  cycle: AsaasCycle;
  /**
   * A assinatura no Asaas nasce do **checkout hospedado** (cartão) em vez de ser criada
   * por nós na API (Pix). Só nesse caso o `asaasSubscriptionId` precisa ser descoberto
   * depois, no webhook — e só nesse caso existe cartão guardado para trocar.
   */
  hostedCheckout: boolean;
}

const METHOD_TRAITS: Record<BillingMethod, MethodTraits> = {
  monthly_card: {
    cadence: 'monthly',
    paymentKind: 'credit_card',
    cycle: 'MONTHLY',
    hostedCheckout: true,
  },
  monthly_pix: { cadence: 'monthly', paymentKind: 'pix', cycle: 'MONTHLY', hostedCheckout: false },
  annual_card: {
    cadence: 'annual',
    paymentKind: 'credit_card',
    cycle: 'YEARLY',
    hostedCheckout: true,
  },
  annual_pix: { cadence: 'annual', paymentKind: 'pix', cycle: 'YEARLY', hostedCheckout: false },
};

/**
 * Plano ainda não contratado (`method === null`) não é mensal nem anual nem cartão: as
 * quatro perguntas respondem `false`. Quem precisa distinguir "sem plano" de "plano que
 * não é X" tem que checar o nulo antes — é o caso do trial.
 */
export function traitsOf(method: BillingMethod | null): MethodTraits | null {
  return method ? METHOD_TRAITS[method] : null;
}

/** Cadência mensal — a pergunta que `=== 'monthly_card'` fazia errado. */
export function isMonthly(method: BillingMethod | null): boolean {
  return traitsOf(method)?.cadence === 'monthly';
}

export function isAnnual(method: BillingMethod | null): boolean {
  return traitsOf(method)?.cadence === 'annual';
}

/**
 * Pago com cartão. Diferente de `isMonthly`: é o que gate corretamente a troca de
 * cartão, a reativação por checkout e o vínculo da assinatura criada pelo Asaas.
 */
export function isCard(method: BillingMethod | null): boolean {
  return traitsOf(method)?.paymentKind === 'credit_card';
}

/** Assinatura criada pelo checkout hospedado (só cartão) — id descoberto no webhook. */
export function usesHostedCheckout(method: BillingMethod | null): boolean {
  return traitsOf(method)?.hostedCheckout === true;
}

/** Forma de pagamento da cobrança gerada pela recorrência deste método. */
export function paymentKindOf(method: BillingMethod | null): PaymentKind {
  // Sem método contratado não há recorrência gerando cobrança; o cartão é o default
  // histórico do produto e mantém o comportamento anterior nesse canto morto.
  return traitsOf(method)?.paymentKind ?? 'credit_card';
}

/** Ciclo a mandar para o Asaas. */
export function cycleOf(method: BillingMethod | null): AsaasCycle {
  return traitsOf(method)?.cycle ?? 'MONTHLY';
}
