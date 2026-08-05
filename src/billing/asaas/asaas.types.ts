/**
 * Tipos da API core v3 do Asaas (apenas o subconjunto que usamos).
 * Valores monetários (`value`, `totalValue`) são em REAIS decimais — a conversão
 * de centavos acontece na borda do `AsaasClient`.
 *
 * **Não há tipo de cartão aqui, de propósito.** Todo pagamento com cartão passa pelo
 * Checkout hospedado do Asaas: número, validade e CVV nunca chegam ao nosso backend
 * nem ao nosso frontend. O que trafega é o link do checkout.
 */

export interface CreateCustomerInput {
  name: string;
  cpfCnpj: string;
  email?: string;
  phone?: string;
  mobilePhone?: string;
  /** Logradouro. O Asaas usa `province` para bairro e não tem campo de UF. */
  address?: string;
  addressNumber?: string;
  complement?: string;
  province?: string;
  city?: string;
  postalCode?: string;
  externalReference?: string;
}

export interface AsaasCustomer {
  id: string; // cus_xxx
  name: string;
  cpfCnpj: string;
}

export type AsaasBillingType = 'CREDIT_CARD' | 'PIX' | 'BOLETO';
export type AsaasCycle = 'MONTHLY' | 'YEARLY';

export interface CreateSubscriptionInput {
  customer: string;
  billingType: AsaasBillingType;
  value: number; // reais
  cycle: AsaasCycle;
  nextDueDate: string; // yyyy-MM-dd
  externalReference?: string;
  description?: string;
}

export interface AsaasSubscription {
  id: string; // sub_xxx
  status: string;
  value: number;
  cycle?: AsaasCycle;
  nextDueDate: string;
  customer?: string;
  externalReference?: string;
  dateCreated?: string;
}

export interface CreatePaymentInput {
  customer: string;
  billingType: AsaasBillingType;
  dueDate: string; // yyyy-MM-dd
  value?: number; // reais — cobrança avulsa de 1 parcela
  totalValue?: number; // reais — parcelado (usar com installmentCount)
  installmentCount?: number;
  externalReference?: string;
  description?: string;
}

/**
 * Situações que tratamos. O `(string & {})` mantém o autocomplete dos valores conhecidos
 * **e** aceita status novos do Asaas sem quebrar o build — a união com `string` puro
 * apagava as sugestões e o compilador deixava qualquer texto passar como se fosse válido.
 */
export type AsaasPaymentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'RECEIVED'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'RECEIVED_IN_CASH'
  | 'PAYMENT_DELETED'
  | (string & {});

export interface AsaasPayment {
  id: string; // pay_xxx
  status: AsaasPaymentStatus;
  value: number;
  netValue?: number;
  billingType: AsaasBillingType;
  dueDate: string;
  invoiceUrl?: string;
  installmentCount?: number;
  subscription?: string;
  /**
   * Cliente dono da cobrança. É a chave de resolução quando um pagamento nasce do
   * Checkout hospedado: o checkout pode não propagar o `externalReference`, mas o
   * cliente é sempre o nosso (`asaasCustomerId`, um por empresa).
   */
  customer?: string;
  dateCreated?: string; // yyyy-MM-dd
  externalReference?: string;
}

export interface ListPaymentsQuery {
  customer?: string;
  subscription?: string;
  externalReference?: string;
  /** Cobranças criadas a partir desta data (yyyy-MM-dd). */
  dateCreatedGe?: string;
  status?: string;
  limit?: number;
}

export interface AsaasList<T> {
  object: 'list';
  hasMore: boolean;
  totalCount: number;
  data: T[];
}

export interface AsaasPixQrCode {
  encodedImage: string; // PNG base64
  payload: string; // copia-e-cola
  expirationDate: string; // yyyy-MM-dd HH:mm:ss
}

// ── Checkout hospedado ───────────────────────────────────────────────────────

export type AsaasChargeType = 'DETACHED' | 'RECURRENT' | 'INSTALLMENT';
export type AsaasCheckoutStatus = 'ACTIVE' | 'PAID' | 'CANCELED' | 'EXPIRED' | (string & {});

export interface CreateCheckoutInput {
  billingTypes: AsaasBillingType[];
  chargeTypes: AsaasChargeType[];
  /** 10 a 1440 minutos. Usamos o teto (24 h) — ver `CHECKOUT_MINUTES_TO_EXPIRE`. */
  minutesToExpire?: number;
  callback: {
    successUrl: string;
    cancelUrl: string;
    expiredUrl?: string;
  };
  items: {
    name: string; // máx. 30 caracteres
    quantity: number;
    value: number; // reais
    description?: string; // máx. 150 caracteres
    externalReference?: string;
  }[];
  /**
   * Id do cliente já cadastrado. **Excludente com `customerData`** — a API recusa os
   * dois juntos. Sempre mandamos o id: é ele que permite reencontrar a assinatura e o
   * pagamento que o checkout gerar.
   */
  customer?: string;
  externalReference?: string;
  /** Obrigatório quando `chargeTypes` inclui `RECURRENT`. */
  subscription?: {
    cycle: AsaasCycle;
    nextDueDate: string; // yyyy-MM-dd
    endDate?: string; // yyyy-MM-dd
  };
  /** Obrigatório quando `chargeTypes` inclui `INSTALLMENT`. */
  installment?: {
    maxInstallmentCount: number; // 1..21
  };
}

export interface AsaasCheckout {
  id: string;
  link?: string;
  status: AsaasCheckoutStatus;
  externalReference?: string;
  /**
   * Campos que a documentação **não** garante no retorno nem no webhook. Ficam
   * opcionais e são lidos de forma defensiva: quando vierem, poupam uma consulta;
   * quando não vierem, a resolução cai no cliente (ver `BillingCheckoutService`).
   */
  customer?: string;
  subscription?: string;
  payment?: string;
}

/**
 * Corpo do webhook do Asaas. `id` é o id do evento (idempotência). Eventos de
 * cobrança trazem `payment`; eventos `CHECKOUT_*` trazem `checkout`.
 */
export interface AsaasWebhookPayload {
  id?: string;
  event?: string; // PAYMENT_CONFIRMED, PAYMENT_OVERDUE, CHECKOUT_PAID…
  dateCreated?: string;
  payment?: AsaasPayment;
  checkout?: AsaasCheckout;
}
