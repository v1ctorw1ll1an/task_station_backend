import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';

/** Tipos de alerta operacional de cobrança (rótulo da métrica + assunto do e-mail). */
export const BILLING_ALERTS = {
  webhook_dead: 'Evento de webhook esgotou as tentativas',
  webhook_silence: 'Nenhum webhook do Asaas recebido — fila possivelmente interrompida',
  payment_unmatched: 'Pagamento confirmado sem cobrança correspondente',
  payment_reversed: 'Pagamento estornado / chargeback',
  payment_blocked_by_lock: 'Empresa em dia e bloqueada por trava administrativa',
  data_retention_purged: 'Dados de empresa cancelada excluídos pela política de retenção',
  /**
   * O checkout foi pago mas não deu para dizer, sem ambiguidade, qual assinatura o
   * Asaas criou. O cliente tem acesso (pagou), mas a recorrência ficou sem vínculo:
   * não dá para reajustar valor nem cancelar até alguém ligar os dois à mão.
   */
  checkout_unresolved: 'Checkout pago sem assinatura identificada — recorrência sem vínculo',
  /** Mesmo problema, do lado das assinaturas de assentos anuais. */
  addon_subscription_orphan: 'Assentos ativados sem assinatura identificada no provedor',
  /**
   * A conta da TaskDY no Asaas está bloqueada ou com recurso desabilitado (cadastro
   * pendente, documento faltando, Pix/checkout não liberado). **Nenhum cliente
   * consegue pagar** por esse caminho até alguém resolver — é o alerta mais urgente
   * da lista, porque a falha é silenciosa do lado de quem paga: ele só vê "tente
   * mais tarde".
   */
  provider_account_blocked: 'Conta no provedor de pagamento bloqueada — ninguém consegue pagar',
} as const;

export type BillingAlertKind = keyof typeof BILLING_ALERTS;

/**
 * Canal único de alerta operacional de cobrança (docs/cobranca-auditoria.md — B8/B9):
 * métrica + log de erro + e-mail interno. **Nunca lança** — alerta que quebra o fluxo
 * que estava alertando não serve para nada.
 */
@Injectable()
export class BillingAlertsService {
  constructor(
    private readonly mailer: MailerService,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(BillingAlertsService.name)
    private readonly logger: PinoLogger,
  ) {}

  async raise(kind: BillingAlertKind, details: Record<string, unknown>): Promise<void> {
    const subject = BILLING_ALERTS[kind];
    try {
      this.metrics.billingAlert(kind);
    } catch {
      // métrica nunca derruba o alerta
    }
    this.logger.error({ kind, ...details }, `Alerta de cobrança: ${subject}`);
    try {
      await this.mailer.sendBillingOpsAlert(subject, { kind, ...details });
    } catch (err: unknown) {
      this.logger.warn({ kind, err }, 'Falha ao enviar e-mail de alerta de cobrança');
    }
  }
}
