import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiTokenScopeGuard } from './api-token-scope.guard';

const TOKEN = { id: 'tok-1', workspaceId: 'ws-1' };

function makeGuard({
  allowed = true,
  projectWorkspace = 'ws-1' as string | null,
}: { allowed?: boolean; projectWorkspace?: string | null } = {}) {
  const reflector = { get: jest.fn().mockReturnValue(allowed) } as unknown as Reflector;
  const findFirst = jest
    .fn()
    .mockResolvedValue(projectWorkspace ? { workspaceId: projectWorkspace } : null);
  const prisma = { project: { findFirst } } as unknown as PrismaService;
  const logger = { warn: jest.fn() } as unknown as PinoLogger;
  return { guard: new ApiTokenScopeGuard(reflector, prisma, logger), findFirst, reflector };
}

function makeContext(request: Record<string, unknown>, type = 'http'): ExecutionContext {
  return {
    getHandler: jest.fn().mockReturnValue('handler'),
    getClass: jest.fn().mockReturnValue('class'),
    getType: jest.fn().mockReturnValue(type),
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/x', ...request }) }),
  } as unknown as ExecutionContext;
}

async function codeOf(promise: Promise<unknown>) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ForbiddenException);
  return ((err as ForbiddenException).getResponse() as { code: string }).code;
}

describe('ApiTokenScopeGuard', () => {
  it('request sem token (navegador/JWT) passa sem consultar nada', async () => {
    const { guard, findFirst, reflector } = makeGuard({ allowed: false });
    await expect(
      guard.canActivate(makeContext({ params: { projectId: 'p-outro' } })),
    ).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
    expect(reflector.get).not.toHaveBeenCalled();
  });

  it('fora de HTTP não interfere', async () => {
    const { guard } = makeGuard({ allowed: false });
    await expect(guard.canActivate(makeContext({ apiToken: TOKEN }, 'ws'))).resolves.toBe(true);
  });

  it('rota sem @AllowApiToken → 403 API_TOKEN_ROUTE_NOT_ALLOWED', async () => {
    const { guard } = makeGuard({ allowed: false });
    expect(
      await codeOf(guard.canActivate(makeContext({ apiToken: TOKEN, params: { projectId: 'p' } }))),
    ).toBe('API_TOKEN_ROUTE_NOT_ALLOWED');
  });

  it('lê o decorator só no handler (não vale no controller inteiro)', async () => {
    const { guard, reflector } = makeGuard();
    await guard.canActivate(makeContext({ apiToken: TOKEN, params: {} }));
    expect(reflector.get).toHaveBeenCalledWith('allowApiToken', 'handler');
  });

  it('rota liberada sem escopo (ex.: /me/api-tokens/current) passa', async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(makeContext({ apiToken: TOKEN, params: {} }))).resolves.toBe(
      true,
    );
  });

  it('workspace do token passa', async () => {
    const { guard } = makeGuard();
    await expect(
      guard.canActivate(makeContext({ apiToken: TOKEN, params: { workspaceId: 'ws-1' } })),
    ).resolves.toBe(true);
  });

  it('outro workspace → 403 API_TOKEN_OUT_OF_SCOPE', async () => {
    const { guard } = makeGuard();
    expect(
      await codeOf(
        guard.canActivate(makeContext({ apiToken: TOKEN, params: { workspaceId: 'ws-2' } })),
      ),
    ).toBe('API_TOKEN_OUT_OF_SCOPE');
  });

  it('projeto do workspace do token passa', async () => {
    const { guard, findFirst } = makeGuard({ projectWorkspace: 'ws-1' });
    await expect(
      guard.canActivate(makeContext({ apiToken: TOKEN, params: { projectId: 'p-1' } })),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p-1' } }));
  });

  it('projeto de outro workspace → 403', async () => {
    const { guard } = makeGuard({ projectWorkspace: 'ws-2' });
    expect(
      await codeOf(guard.canActivate(makeContext({ apiToken: TOKEN, params: { projectId: 'p' } }))),
    ).toBe('API_TOKEN_OUT_OF_SCOPE');
  });

  it('projeto inexistente dá a mesma resposta de fora do escopo', async () => {
    const { guard } = makeGuard({ projectWorkspace: null });
    expect(
      await codeOf(guard.canActivate(makeContext({ apiToken: TOKEN, params: { projectId: 'p' } }))),
    ).toBe('API_TOKEN_OUT_OF_SCOPE');
  });

  it('workspace certo com projeto de outro workspace → 403', async () => {
    const { guard } = makeGuard({ projectWorkspace: 'ws-2' });
    expect(
      await codeOf(
        guard.canActivate(
          makeContext({ apiToken: TOKEN, params: { workspaceId: 'ws-1', projectId: 'p' } }),
        ),
      ),
    ).toBe('API_TOKEN_OUT_OF_SCOPE');
  });

  it('rota de empresa (:companyId) → 403', async () => {
    const { guard } = makeGuard();
    expect(
      await codeOf(
        guard.canActivate(makeContext({ apiToken: TOKEN, params: { companyId: 'c-1' } })),
      ),
    ).toBe('API_TOKEN_OUT_OF_SCOPE');
  });
});
