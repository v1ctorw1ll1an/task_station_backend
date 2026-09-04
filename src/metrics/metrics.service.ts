import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';

export const METRIC_HTTP_REQUESTS_TOTAL = 'taskdy_http_requests_total';
export const METRIC_HTTP_REQUEST_DURATION = 'taskdy_http_request_duration_seconds';
export const METRIC_WS_CONNECTIONS = 'taskdy_ws_connections';
export const METRIC_BILLING_WEBHOOK_TOTAL = 'taskdy_billing_webhook_events_total';
export const METRIC_BILLING_RECONCILE_TOTAL = 'taskdy_billing_reconcile_total';
export const METRIC_BILLING_ALERTS_TOTAL = 'taskdy_billing_alerts_total';
export const METRIC_BILLING_LAST_WEBHOOK_AGE = 'taskdy_billing_last_webhook_age_seconds';

/** Desfecho de um evento de webhook (rótulo da métrica). */
export type WebhookOutcome =
  | 'received'
  | 'duplicate'
  | 'persist_failed'
  | 'invalid'
  /** Evento de outro produto na mesma conta Asaas — recusado antes do inbox. */
  | 'foreign'
  | 'processed'
  | 'ignored'
  | 'retry'
  | 'dead';

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric(METRIC_HTTP_REQUESTS_TOTAL)
    private readonly httpRequests: Counter<string>,
    @InjectMetric(METRIC_HTTP_REQUEST_DURATION)
    private readonly httpDuration: Histogram<string>,
    @InjectMetric(METRIC_WS_CONNECTIONS)
    private readonly wsConnections: Gauge<string>,
    @InjectMetric(METRIC_BILLING_WEBHOOK_TOTAL)
    private readonly billingWebhooks: Counter<string>,
    @InjectMetric(METRIC_BILLING_RECONCILE_TOTAL)
    private readonly billingReconciles: Counter<string>,
    @InjectMetric(METRIC_BILLING_ALERTS_TOTAL)
    private readonly billingAlerts: Counter<string>,
    @InjectMetric(METRIC_BILLING_LAST_WEBHOOK_AGE)
    private readonly billingWebhookAge: Gauge<string>,
  ) {}

  // ── Cobrança (docs/cobranca-auditoria.md — B9) ────────────────────────────

  /** Um evento de webhook do Asaas em cada etapa do ciclo (recebido → desfecho). */
  billingWebhook(event: string, outcome: WebhookOutcome): void {
    this.billingWebhooks.inc({ event, outcome });
  }

  /** Conciliação que trouxe o estado do Asaas sem depender de webhook. */
  billingReconcile(source: 'status' | 'cron_charge' | 'cron_subscription'): void {
    this.billingReconciles.inc({ source });
  }

  /** Alerta operacional de cobrança (ver `BillingAlertsService`). */
  billingAlert(kind: string): void {
    this.billingAlerts.inc({ kind });
  }

  /** Idade do último webhook recebido — alto = fila do Asaas provavelmente parada. */
  billingLastWebhookAge(seconds: number): void {
    this.billingWebhookAge.set(seconds);
  }

  recordHttp(method: string, route: string, status: number, durationSeconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  wsConnect(namespace: string): void {
    this.wsConnections.inc({ namespace });
  }

  wsDisconnect(namespace: string): void {
    this.wsConnections.dec({ namespace });
  }
}
