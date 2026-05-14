import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<{ method: string; route?: { path?: string }; url: string }>();
    const res = http.getResponse<{ statusCode: number }>();
    const start = process.hrtime.bigint();

    const finalize = (statusOverride?: number) => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ?? this.normalizeUrl(req.url);
      const status = statusOverride ?? res.statusCode;
      this.metrics.recordHttp(req.method, route, status, durationSeconds);
    };

    return next.handle().pipe(
      tap({
        next: () => finalize(),
        error: (err: { status?: number; statusCode?: number }) => {
          finalize(err?.status ?? err?.statusCode ?? 500);
        },
      }),
    );
  }

  private normalizeUrl(url: string): string {
    // Strip query string and replace UUIDs / numeric IDs with placeholders to
    // keep cardinality bounded.
    const path = url.split('?')[0];
    return path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+(?=\/|$)/g, '/:id');
  }
}
