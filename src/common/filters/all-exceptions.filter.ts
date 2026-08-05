import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Request } from 'express';
import { Logger } from 'nestjs-pino';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { id?: string }>();

    const isHttpException = exception instanceof HttpException;
    // Erros de middleware Express (ex.: body-parser → 413, multer → 413) chegam
    // como Error plano com .status/.statusCode. Respeitamos esse contrato para
    // não mascarar 4xx em 500.
    const middlewareStatus =
      !isHttpException && exception instanceof Error
        ? ((exception as Error & { status?: number; statusCode?: number }).status ??
          (exception as Error & { status?: number; statusCode?: number }).statusCode)
        : undefined;

    const statusCode = isHttpException
      ? exception.getStatus()
      : (middlewareStatus ?? HttpStatus.INTERNAL_SERVER_ERROR);

    const rawResponse = isHttpException ? exception.getResponse() : null;
    const message = isHttpException
      ? typeof rawResponse === 'string'
        ? rawResponse
        : ((rawResponse as { message?: string | string[] })?.message ?? exception.message)
      : middlewareStatus
        ? (exception as Error).message
        : 'Internal server error';

    // Código de erro estável (contrato com o frontend), quando a exceção o define
    // no corpo — ex.: { code: 'COMPANY_BLOCKED' } do gate de cobrança. O `reason`
    // acompanha porque é ele que diz ao front QUAL bloqueio é (vencido, limitado
    // pela administração, suspenso) e, portanto, o que oferecer ao usuário.
    const corpo =
      isHttpException && typeof rawResponse === 'object' && rawResponse !== null
        ? (rawResponse as { code?: string; reason?: string })
        : undefined;
    const code = corpo?.code;
    const reason = corpo?.reason;

    const logContext = {
      statusCode,
      method: request.method,
      path: request.url,
      requestId: request.id,
      ...(statusCode >= 500 && {
        stack: exception instanceof Error ? exception.stack : undefined,
      }),
    };

    const logMessage = `${request.method} ${request.url} → ${statusCode}`;

    if (statusCode >= 500) {
      this.logger.error(logContext, logMessage, AllExceptionsFilter.name);
    } else if (statusCode >= 400) {
      this.logger.warn(logContext, logMessage, AllExceptionsFilter.name);
    }

    httpAdapter.reply(
      ctx.getResponse(),
      {
        statusCode,
        message,
        ...(code ? { code } : {}),
        ...(reason ? { reason } : {}),
        timestamp: new Date().toISOString(),
        path: request.url,
      },
      statusCode,
    );
  }
}
