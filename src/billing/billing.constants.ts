/** Duração do período de teste (trial) de uma empresa recém-criada — R4. */
export const TRIAL_DAYS = 7;

/**
 * Lugares do período de teste: **5 pessoas além do admin que criou a empresa**.
 *
 * O criador ocupa um lugar como qualquer outro (`countOccupiedSeats` conta toda
 * membership de empresa), então o total precisa ser 5 + 1. Com o valor antigo de 1,
 * o teste não comportava ninguém: o primeiro convite já batia em "todos em uso" e
 * mandava assinar antes de a empresa ver o produto funcionando com o time.
 */
export const TRIAL_SEATS = 6;

/** Dias de carência após falha de renovação no cartão antes do somente-leitura — R22. */
export const GRACE_DAYS = 3;

/**
 * Validade do checkout hospedado do Asaas. O teto que a API aceita (24 h) — tempo de
 * sobra para quem precisa buscar o cartão da empresa, sem deixar uma compra pendurada
 * por dias segurando o intento.
 */
export const CHECKOUT_MINUTES_TO_EXPIRE = 1_440;

/** Limites de tamanho dos campos do item de checkout, impostos pelo Asaas. */
export const CHECKOUT_ITEM_NAME_MAX = 30;
export const CHECKOUT_ITEM_DESCRIPTION_MAX = 150;

/**
 * Tolerância ao casar um pagamento do Asaas com a nossa cobrança pelo valor, quando o
 * `externalReference` não veio. Um centavo — o suficiente para absorver a ida e volta
 * entre centavos inteiros e reais decimais, e pouco o bastante para não confundir duas
 * compras diferentes.
 */
export const PAYMENT_MATCH_TOLERANCE_CENTS = 1;
