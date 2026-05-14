import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  PrometheusModule,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import {
  METRIC_HTTP_REQUESTS_TOTAL,
  METRIC_HTTP_REQUEST_DURATION,
  METRIC_WS_CONNECTIONS,
  MetricsService,
} from './metrics.service';

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      global: true,
      controller: MetricsController,
      defaultMetrics: { enabled: true },
      defaultLabels: { app: 'taskdy' },
    }),
  ],
  providers: [
    MetricsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    makeCounterProvider({
      name: METRIC_HTTP_REQUESTS_TOTAL,
      help: 'Total de requisições HTTP recebidas.',
      labelNames: ['method', 'route', 'status'],
    }),
    makeHistogramProvider({
      name: METRIC_HTTP_REQUEST_DURATION,
      help: 'Duração de requisições HTTP em segundos.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    }),
    makeGaugeProvider({
      name: METRIC_WS_CONNECTIONS,
      help: 'Conexões WebSocket ativas por namespace.',
      labelNames: ['namespace'],
    }),
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
