import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';

export const METRIC_HTTP_REQUESTS_TOTAL = 'taskdy_http_requests_total';
export const METRIC_HTTP_REQUEST_DURATION = 'taskdy_http_request_duration_seconds';
export const METRIC_WS_CONNECTIONS = 'taskdy_ws_connections';

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric(METRIC_HTTP_REQUESTS_TOTAL)
    private readonly httpRequests: Counter<string>,
    @InjectMetric(METRIC_HTTP_REQUEST_DURATION)
    private readonly httpDuration: Histogram<string>,
    @InjectMetric(METRIC_WS_CONNECTIONS)
    private readonly wsConnections: Gauge<string>,
  ) {}

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
