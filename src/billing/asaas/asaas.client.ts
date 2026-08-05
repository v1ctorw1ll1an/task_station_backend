import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { BillingAlertsService } from '../billing-alerts.service';
import { AsaasAccountError, ehProblemaDaNossaConta } from './asaas.errors';
import type {
  AsaasCheckout,
  AsaasCustomer,
  AsaasList,
  AsaasPayment,
  AsaasPixQrCode,
  AsaasSubscription,
  CreateCheckoutInput,
  CreateCustomerInput,
  CreatePaymentInput,
  CreateSubscriptionInput,
  ListPaymentsQuery,
} from './asaas.types';

interface AsaasErrorBody {
  errors?: { code?: string; description?: string }[];
}

/**
 * Intervalo mínimo entre dois alertas do mesmo problema de conta. Conta bloqueada
 * afeta **todo** cliente que tentar pagar: sem isto, uma tarde de tentativas viraria
 * centenas de e-mails idênticos para a operação — e alerta que vira ruído é alerta
 * que ninguém lê.
 */
const ALERTA_COOLDOWN_MS = 30 * 60_000;

/**
 * Cliente HTTP fino para a API core v3 do Asaas. Autenticação por header
 * `access_token`.
 *
 * Nenhum método aqui aceita dado de cartão: o pagamento com cartão acontece na
 * página hospedada do Asaas (`createCheckout`), e o que voltamos a ver é só o
 * resultado. Ainda assim o corpo das requests nunca é logado — o cadastro do
 * cliente carrega CPF e endereço.
 */
@Injectable()
export class AsaasClient {
  /** Último alerta por mensagem de conta — ver `ALERTA_COOLDOWN_MS`. */
  private readonly ultimoAlerta = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly alerts: BillingAlertsService,
    @InjectPinoLogger(AsaasClient.name)
    private readonly logger: PinoLogger,
  ) {}

  createCustomer(input: CreateCustomerInput): Promise<AsaasCustomer> {
    return this.request<AsaasCustomer>('POST', '/customers', input);
  }

  /**
   * Atualiza o cadastro do cliente no Asaas. Necessário quando a empresa corrige
   * razão social ou CNPJ: sem isto as cobranças seguiriam saindo com o documento
   * antigo, que é o que aparece na nota e no extrato do cliente.
   */
  updateCustomer(customerId: string, input: Partial<CreateCustomerInput>): Promise<AsaasCustomer> {
    return this.request<AsaasCustomer>('POST', `/customers/${customerId}`, input);
  }

  // ── Checkout hospedado ─────────────────────────────────────────────────────

  /**
   * Cria uma sessão de pagamento hospedada pelo Asaas e devolve o link para onde o
   * cliente é mandado. É o **único** caminho de cartão do produto: o PAN não passa
   * por aqui em momento nenhum.
   *
   * A API tem só criar e cancelar — **não existe GET de checkout**. Quem precisa
   * saber se foi pago descobre pelo webhook `CHECKOUT_PAID` ou procurando a cobrança
   * gerada pelo cliente (`listPayments`).
   */
  createCheckout(input: CreateCheckoutInput): Promise<AsaasCheckout> {
    return this.request<AsaasCheckout>('POST', '/checkouts', input);
  }

  /** Encerra um checkout ainda aberto (troca de forma de pagamento, expiração). */
  cancelCheckout(checkoutId: string): Promise<AsaasCheckout> {
    return this.request<AsaasCheckout>('POST', `/checkouts/${checkoutId}/cancel`);
  }

  createSubscription(input: CreateSubscriptionInput): Promise<AsaasSubscription> {
    return this.request<AsaasSubscription>('POST', '/subscriptions', input);
  }

  getSubscription(subscriptionId: string): Promise<AsaasSubscription> {
    return this.request<AsaasSubscription>('GET', `/subscriptions/${subscriptionId}`);
  }

  deleteSubscription(subscriptionId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request<{ deleted: boolean; id: string }>(
      'DELETE',
      `/subscriptions/${subscriptionId}`,
    );
  }

  /**
   * Atualiza o valor da assinatura recorrente — só as cobranças **futuras**.
   * `updatePendingPayments` fica em `false` de propósito: a fatura já gerada é do
   * ciclo que o cliente já está usando com os assentos antigos. Assento comprado no
   * meio do mês é pago à parte, cheio, numa cobrança avulsa; o valor novo da
   * recorrência vale da cobrança seguinte em diante.
   */
  updateSubscriptionValue(subscriptionId: string, value: number): Promise<AsaasSubscription> {
    return this.request<AsaasSubscription>('PUT', `/subscriptions/${subscriptionId}`, {
      value,
      updatePendingPayments: false,
    });
  }

  /** Assinaturas de um cliente — usado para não criar uma recorrência duplicada. */
  listCustomerSubscriptions(customerId: string): Promise<AsaasList<AsaasSubscription>> {
    return this.request<AsaasList<AsaasSubscription>>(
      'GET',
      `/subscriptions?customer=${encodeURIComponent(customerId)}`,
    );
  }

  listSubscriptionPayments(subscriptionId: string): Promise<AsaasList<AsaasPayment>> {
    return this.request<AsaasList<AsaasPayment>>(
      'GET',
      `/subscriptions/${subscriptionId}/payments`,
    );
  }

  createPayment(input: CreatePaymentInput): Promise<AsaasPayment> {
    return this.request<AsaasPayment>('POST', '/payments', input);
  }

  getPayment(paymentId: string): Promise<AsaasPayment> {
    return this.request<AsaasPayment>('GET', `/payments/${paymentId}`);
  }

  /**
   * Cobranças do cliente, filtráveis. É como encontramos o pagamento que um checkout
   * gerou — o checkout não tem GET próprio e o `externalReference` pode não propagar
   * para a cobrança, então sobra procurar pelo cliente numa janela de tempo.
   */
  listPayments(query: ListPaymentsQuery): Promise<AsaasList<AsaasPayment>> {
    const params = new URLSearchParams();
    if (query.customer) params.set('customer', query.customer);
    if (query.subscription) params.set('subscription', query.subscription);
    if (query.externalReference) params.set('externalReference', query.externalReference);
    if (query.dateCreatedGe) params.set('dateCreated[ge]', query.dateCreatedGe);
    if (query.status) params.set('status', query.status);
    params.set('limit', String(query.limit ?? 20));
    return this.request<AsaasList<AsaasPayment>>('GET', `/payments?${params.toString()}`);
  }

  /** Remove uma cobrança ainda não paga (usado ao trocar de método de pagamento). */
  deletePayment(paymentId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request<{ deleted: boolean; id: string }>('DELETE', `/payments/${paymentId}`);
  }

  getPixQrCode(paymentId: string): Promise<AsaasPixQrCode> {
    return this.request<AsaasPixQrCode>('GET', `/payments/${paymentId}/pixQrCode`);
  }

  // ── infra ──────────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const baseUrl = this.config.get<string>('ASAAS_API_URL');
    const apiKey = this.config.get<string>('ASAAS_API_KEY');
    if (!baseUrl || !apiKey) {
      throw new ServiceUnavailableException('Integração de cobrança não configurada');
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          access_token: apiKey,
          'User-Agent': 'TaskDY',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err: unknown) {
      // Não logamos `body` — pode conter dados de cartão.
      this.logger.error({ method, path, err }, 'Asaas request failed (network)');
      throw new BadGatewayException('Falha de comunicação com o provedor de pagamento');
    }

    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : {};

    if (!res.ok) {
      const description = this.extractError(data);

      // Recusa que é problema da NOSSA conta (cadastro pendente, recurso desabilitado):
      // não é erro do cliente e ele não tem o que fazer. Vira 503 com mensagem neutra e
      // um alerta para a operação — repassar o texto do provedor mandaria o admin da
      // empresa "regularizar a situação cadastral" que não é dele.
      if (res.status === 400 && ehProblemaDaNossaConta(description)) {
        this.logger.error(
          { method, path, status: res.status, description },
          'Asaas recusou por situação da nossa conta',
        );
        await this.alertarContaBloqueada(path, description!);
        throw new AsaasAccountError(description!);
      }

      this.logger.warn({ method, path, status: res.status, description }, 'Asaas returned error');
      // 400 = erro de negócio do cliente (validação, dado inválido) → repassa a mensagem.
      if (res.status === 400) {
        throw new BadRequestException(description ?? 'Pagamento não autorizado');
      }
      throw new BadGatewayException('O provedor de pagamento rejeitou a solicitação');
    }

    return data as T;
  }

  /** Avisa a operação, no máximo uma vez por meia hora para cada mensagem. Nunca lança. */
  private async alertarContaBloqueada(path: string, description: string): Promise<void> {
    const agora = Date.now();
    const ultimo = this.ultimoAlerta.get(description) ?? 0;
    if (agora - ultimo < ALERTA_COOLDOWN_MS) return;
    this.ultimoAlerta.set(description, agora);

    try {
      await this.alerts.raise('provider_account_blocked', { path, description });
    } catch (err: unknown) {
      this.logger.warn({ path, err }, 'Falha ao alertar bloqueio da conta no provedor');
    }
  }

  private extractError(data: unknown): string | undefined {
    const body = data as AsaasErrorBody;
    if (body?.errors?.length) {
      return body.errors
        .map((e) => e.description)
        .filter(Boolean)
        .join('; ');
    }
    return undefined;
  }
}
