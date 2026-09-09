/**
 * Cálculo de preço da cobrança (TaskDY) — funções puras e testáveis.
 *
 * Convenção: tudo em CENTAVOS inteiros. Um único `Math.round` por fórmula, no
 * total final (nunca por assento). A conversão para reais decimais acontece só
 * na borda do cliente Asaas.
 *
 * Regras (docs/cobranca-regras.md): a base mensal de R$49,90 já inclui 1 assento
 * (o criador — R8/R11); cada assento adicional custa R$19,90/mês. O anual = 12×
 * o mensal com 25% de desconto, valendo para Pix e cartão.
 *
 * **Não existe proração.** Mudança de assento cobra o preço cheio do assento — um
 * mês inteiro no plano mensal, um ano inteiro no anual — independente do dia em que
 * é feita. O que muda é *quando* passa a valer, não o preço: a compra libera o
 * assento assim que o pagamento é confirmado, e a redução só vale na renovação.
 *
 * **Não existe parcelamento.** O anual é pagamento único, no Pix ou no cartão, pelo
 * mesmo valor nos dois. Foi tirar o 12× que permitiu o anual no cartão virar
 * assinatura recorrente — o Asaas não combina parcelamento com assinatura.
 */

export const MONTHLY_BASE_CENTS = 4_990; // inclui o 1º assento (R8/R11)
export const MONTHLY_EXTRA_SEAT_CENTS = 1_990; // por assento adicional
/**
 * Teto de assentos numa contratação. Não é regra de negócio, é sanidade: impede
 * que um dedo escorregado no campo de quantidade vire uma cobrança absurda. A tela
 * limita o input pelo mesmo número, que vem do backend no status.
 */
export const MAX_SEATS = 1_000;
export const ANNUAL_DISCOUNT = 0.25; // 25% no plano anual (Pix e cartão)
/**
 * Preço de um assento adicional no plano ANUAL, por ano. Derivado do mensal com o
 * mesmo desconto do plano — assento extra não sai mais caro que o contratado junto.
 * R$179,10.
 */
export const ANNUAL_SEAT_CENTS = Math.round(MONTHLY_EXTRA_SEAT_CENTS * 12 * (1 - ANNUAL_DISCOUNT));

/** Valor mensal total para `seats` assentos comprados. */
export function monthlyTotalCents(seats: number): number {
  assertSeats(seats);
  return MONTHLY_BASE_CENTS + (seats - 1) * MONTHLY_EXTRA_SEAT_CENTS;
}

/**
 * Valor mensal em REAIS decimais para `seats` assentos — formato que o Asaas
 * espera no valor da assinatura recorrente. Ponto único de conversão para quem
 * precisa manter a recorrência alinhada aos assentos comprados.
 */
export function monthlyValueReais(seats: number): number {
  return Number((monthlyTotalCents(seats) / 100).toFixed(2));
}

/** Valor anual (Pix ou cartão): 12× o mensal com 25% de desconto. */
export function annualTotalCents(seats: number): number {
  return Math.round(monthlyTotalCents(seats) * 12 * (1 - ANNUAL_DISCOUNT));
}

/** Valor anual em REAIS decimais — para o valor da assinatura YEARLY no Asaas. */
export function annualValueReais(seats: number): number {
  return Number((annualTotalCents(seats) / 100).toFixed(2));
}

/**
 * Cobrança avulsa de assento no plano MENSAL: preço cheio do assento adicional,
 * `quantity` vezes. Não depende do dia do mês — quem compra dia 28 paga o mesmo que
 * quem compra dia 1, e o que muda é que a mensalidade só sobe na cobrança seguinte.
 */
export function monthlySeatChargeCents(quantity: number): number {
  assertQuantity(quantity);
  return quantity * MONTHLY_EXTRA_SEAT_CENTS;
}

/**
 * Cobrança de assento no plano ANUAL: um ano cheio por assento. Vira uma assinatura
 * própria no Asaas, com renovação na data da compra — daí o preço ser de 12 meses e
 * não do que resta do ciclo do plano.
 */
export function annualSeatChargeCents(quantity: number): number {
  assertQuantity(quantity);
  return quantity * ANNUAL_SEAT_CENTS;
}

/** Reais decimais da assinatura anual de assentos (valor que vai para o Asaas). */
export function annualSeatValueReais(quantity: number): number {
  return Number((annualSeatChargeCents(quantity) / 100).toFixed(2));
}

/**
 * Assentos que a empresa tem direito de usar: os do plano mais os comprados avulsos
 * no anual. Ponto único da conta — `assertSeatAvailable`, o status da tela e o painel
 * do superusuário precisam concordar, e concordar por construção é mais barato do que
 * por revisão.
 */
export function entitledSeats(sub: { purchasedSeats: number; addonSeats: number }): number {
  return sub.purchasedSeats + sub.addonSeats;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function assertSeats(seats: number): void {
  if (!Number.isInteger(seats) || seats < 1) {
    throw new RangeError(`seats deve ser inteiro >= 1 (recebido: ${seats})`);
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`quantity deve ser inteiro >= 1 (recebido: ${quantity})`);
  }
}
