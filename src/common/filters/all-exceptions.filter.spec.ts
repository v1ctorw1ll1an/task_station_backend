import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeHttpAdapterHost(replyMock: jest.Mock): HttpAdapterHost {
  return { httpAdapter: { reply: replyMock } } as unknown as HttpAdapterHost;
}

function makeHost(req: Record<string, unknown>, res: Record<string, unknown> = {}): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
}

function makeFilter() {
  const reply = jest.fn();
  const logger = makeLogger();
  const filter = new AllExceptionsFilter(makeHttpAdapterHost(reply), logger as any);
  return { filter, reply, logger };
}

const REQ = { method: 'POST', url: '/api/v1/foo', id: 'req-1' };

// ── 4xx ────────────────────────────────────────────────────────────────────────

describe('AllExceptionsFilter — 4xx HttpExceptions', () => {
  it('loga 400 como warn e responde com body estruturado', () => {
    const { filter, reply, logger } = makeFilter();
    const exception = new BadRequestException('Campo X obrigatório');

    filter.catch(exception, makeHost(REQ));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    const [ctx, msg] = logger.warn.mock.calls[0];
    expect(ctx).toEqual(
      expect.objectContaining({
        statusCode: 400,
        method: 'POST',
        path: '/api/v1/foo',
        requestId: 'req-1',
      }),
    );
    expect(ctx).not.toHaveProperty('stack');
    expect(msg).toBe('POST /api/v1/foo → 400');
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 400,
        message: 'Campo X obrigatório',
        path: '/api/v1/foo',
        timestamp: expect.any(String),
      }),
      400,
    );
  });

  it('loga 403 como warn', () => {
    const { filter, logger } = makeFilter();
    filter.catch(new ForbiddenException('Sem permissão'), makeHost(REQ));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
      'POST /api/v1/foo → 403',
      'AllExceptionsFilter',
    );
  });

  it('extrai message de array (validation pipe)', () => {
    const { filter, reply } = makeFilter();
    const exc = new HttpException(
      { message: ['email inválido', 'senha curta'], statusCode: 400 },
      400,
    );
    filter.catch(exc, makeHost(REQ));
    const body = reply.mock.calls[0][1];
    expect(body.message).toEqual(['email inválido', 'senha curta']);
  });

  it('aceita response string puro', () => {
    const { filter, reply } = makeFilter();
    const exc = new HttpException('mensagem direta', 418);
    filter.catch(exc, makeHost(REQ));
    expect(reply.mock.calls[0][1].message).toBe('mensagem direta');
  });
});

// ── 5xx ────────────────────────────────────────────────────────────────────────

describe('AllExceptionsFilter — 5xx', () => {
  it('loga HttpException 500 como error com stack', () => {
    const { filter, logger } = makeFilter();
    const exc = new InternalServerErrorException('boom');
    filter.catch(exc, makeHost(REQ));
    expect(logger.error).toHaveBeenCalledTimes(1);
    const ctx = logger.error.mock.calls[0][0];
    expect(ctx.statusCode).toBe(500);
    expect(ctx.stack).toBeDefined();
  });

  it('erro não-HttpException vira 500 com message genérica', () => {
    const { filter, reply, logger } = makeFilter();
    filter.catch(new Error('falha aleatória'), makeHost(REQ));

    expect(logger.error).toHaveBeenCalled();
    const body = reply.mock.calls[0][1];
    expect(body).toEqual(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
        path: '/api/v1/foo',
      }),
    );
    expect(reply.mock.calls[0][2]).toBe(500);
  });

  it('exception não-Error não inclui stack no contexto', () => {
    const { filter, logger } = makeFilter();
    filter.catch('apenas uma string', makeHost(REQ));
    const ctx = logger.error.mock.calls[0][0];
    expect(ctx.statusCode).toBe(500);
    expect(ctx.stack).toBeUndefined();
  });
});

// ── outros ─────────────────────────────────────────────────────────────────────

describe('AllExceptionsFilter — comportamento geral', () => {
  it('inclui timestamp ISO no body', () => {
    const { filter, reply } = makeFilter();
    filter.catch(new BadRequestException('x'), makeHost(REQ));
    const body = reply.mock.calls[0][1];
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passa o response do httpAdapter para reply', () => {
    const { filter, reply } = makeFilter();
    const res = { sentinel: true };
    filter.catch(new BadRequestException('x'), makeHost(REQ, res));
    expect(reply.mock.calls[0][0]).toBe(res);
  });

  it('NÃO loga (sem warn nem error) para status < 400', () => {
    // Status 301 (redirect) via HttpException
    const { filter, logger } = makeFilter();
    filter.catch(new HttpException('redirect', 301), makeHost(REQ));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
