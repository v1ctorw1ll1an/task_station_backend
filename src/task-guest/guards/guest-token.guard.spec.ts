import { ExecutionContext, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { TaskGuestRepository } from '../task-guest.repository';
import { GuestTokenGuard } from './guest-token.guard';

function makeRepo(
  overrides: Partial<Record<keyof TaskGuestRepository, jest.Mock>> = {},
): jest.Mocked<TaskGuestRepository> {
  return {
    findActiveGuestByTokenHash: jest.fn(),
    touchLastAccessed: jest.fn().mockResolvedValue(undefined),
    findActiveTaskById: jest.fn(),
    createGuest: jest.fn(),
    listActiveGuestsByTask: jest.fn(),
    findActiveGuestById: jest.fn(),
    softDeleteGuest: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<TaskGuestRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function makeGuard(repo: jest.Mocked<TaskGuestRepository>) {
  const logger = makeLogger();
  return { guard: new GuestTokenGuard(repo, logger as any), logger };
}

function makeActiveGuest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'guest-1',
    taskId: 'task-1',
    task: {
      id: 'task-1',
      projectId: 'project-1',
      deletedAt: null,
      project: { id: 'project-1', deletedAt: null },
    },
    ...overrides,
  };
}

describe('GuestTokenGuard', () => {
  // Happy path: token válido → popula guestContext e atualiza lastAccessedAt
  it('autoriza, popula request.guestContext e chama touchLastAccessed', async () => {
    const repo = makeRepo({
      findActiveGuestByTokenHash: jest.fn().mockResolvedValue(makeActiveGuest()),
    });
    const { guard } = makeGuard(repo);
    const rawToken = 'abc123xyz';
    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const req: Record<string, unknown> = { params: { token: rawToken } };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);

    expect(repo.findActiveGuestByTokenHash).toHaveBeenCalledWith(expectedHash);
    expect(req.guestContext).toEqual({
      guestId: 'guest-1',
      taskId: 'task-1',
      projectId: 'project-1',
    });
    expect(repo.touchLastAccessed).toHaveBeenCalledWith('guest-1');
  });

  // Token ausente — mesmo erro genérico que token inválido (não vazar diferenciação)
  it('lança NotFoundException quando token ausente nos params', async () => {
    const repo = makeRepo();
    const { guard } = makeGuard(repo);
    await expect(guard.canActivate(makeContext({ params: {} }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.findActiveGuestByTokenHash).not.toHaveBeenCalled();
  });

  // Token vazio (string vazia) — também rejeita
  it('lança NotFoundException quando token é string vazia', async () => {
    const repo = makeRepo();
    const { guard } = makeGuard(repo);
    await expect(guard.canActivate(makeContext({ params: { token: '' } }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Token desconhecido — 404 padrão, não 401/403 (mantém estrutura opaca)
  it('lança NotFoundException quando hash não encontra registro ativo', async () => {
    const repo = makeRepo({ findActiveGuestByTokenHash: jest.fn().mockResolvedValue(null) });
    const { guard } = makeGuard(repo);
    await expect(
      guard.canActivate(makeContext({ params: { token: 'fake' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.touchLastAccessed).not.toHaveBeenCalled();
  });

  // Task soft-deletada — acesso negado mesmo com token válido
  it('lança NotFoundException quando task foi soft-deletada', async () => {
    const repo = makeRepo({
      findActiveGuestByTokenHash: jest.fn().mockResolvedValue(
        makeActiveGuest({
          task: {
            id: 'task-1',
            projectId: 'project-1',
            deletedAt: new Date(),
            project: { id: 'project-1', deletedAt: null },
          },
        }),
      ),
    });
    const { guard } = makeGuard(repo);
    await expect(
      guard.canActivate(makeContext({ params: { token: 'ok' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.touchLastAccessed).not.toHaveBeenCalled();
  });

  // Project soft-deletado — também nega
  it('lança NotFoundException quando project foi soft-deletado', async () => {
    const repo = makeRepo({
      findActiveGuestByTokenHash: jest.fn().mockResolvedValue(
        makeActiveGuest({
          task: {
            id: 'task-1',
            projectId: 'project-1',
            deletedAt: null,
            project: { id: 'project-1', deletedAt: new Date() },
          },
        }),
      ),
    });
    const { guard } = makeGuard(repo);
    await expect(
      guard.canActivate(makeContext({ params: { token: 'ok' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // Segurança: nenhum log contém o token cru — só prefixo do hash
  it('nunca loga o token cru', async () => {
    const repo = makeRepo({ findActiveGuestByTokenHash: jest.fn().mockResolvedValue(null) });
    const { guard, logger } = makeGuard(repo);
    const rawToken = 'sensitive-token-xyz-9876543210';

    await expect(
      guard.canActivate(makeContext({ params: { token: rawToken } })),
    ).rejects.toBeInstanceOf(NotFoundException);

    const allCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
      ...logger.debug.mock.calls,
    ];
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toContain(rawToken);
    }
  });
});
