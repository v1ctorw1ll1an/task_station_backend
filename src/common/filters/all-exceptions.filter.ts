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
    const statusCode = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawResponse = isHttpException ? exception.getResponse() : null;
    const message = isHttpException
      ? typeof rawResponse === 'string'
        ? rawResponse
        : ((rawResponse as { message?: string | string[] })?.message ?? exception.message)
      : 'Internal server error';

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
        timestamp: new Date().toISOString(),
        path: request.url,
      },
      statusCode,
    );
  }
}
