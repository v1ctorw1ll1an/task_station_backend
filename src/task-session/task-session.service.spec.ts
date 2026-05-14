import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KanbanGateway } from '../projeto/kanban.gateway';
import { TaskSessionService } from './task-session.service';

// ── helpers ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-05-15T10:00:00Z');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeGateway(): jest.Mocked<KanbanGateway> {
  return {
    emitToProject: jest.fn(),
    emitToWorkspace: jest.fn(),
    emitToCompany: jest.fn(),
  } as unknown as jest.Mocked<KanbanGateway>;
}

function makePrisma(
  parts: Partial<{
    task: any;
    taskSession: any;
    workspace: any;
    membership: any;
  }> = {},
) {
  return {
    task: { findFirst: jest.fn().mockResolvedValue(null), ...(parts.task ?? {}) },
    taskSession: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      ...(parts.taskSession ?? {}),
    },
    workspace: { findFirst: jest.fn().mockResolvedValue(null), ...(parts.workspace ?? {}) },
    membership: { findFirst: jest.fn().mockResolvedValue(null), ...(parts.membership ?? {}) },
  } as unknown as PrismaService;
}

function makeService(prisma: PrismaService = makePrisma()) {
  const gateway = makeGateway();
  const logger = makeLogger();
  return { service: new TaskSessionService(prisma, gateway, logger as any), gateway, prisma };
}

const TASK_FIXTURE = {
  id: 't-1',
  title: 'Fix login',
  taskNumber: 42,
  project: {
    id: 'p-1',
    name: 'Backend',
    workspaceId: 'ws-1',
    workspace: { id: 'ws-1', name: 'Eng', companyId: 'c-1' },
  },
};

const SESSION_FIXTURE = {
  id: 's-1',
  taskId: 't-1',
  userId: 'u-1',
  status: 'running' as const,
  startedAt: NOW,
  resumedAt: NOW,
  pausedAt: null,
  stoppedAt: null,
  totalSeconds: 0,
  task: TASK_FIXTURE,
  user: { id: 'u-1', name: 'Alice', photoUrl: null },
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

// ── start ──────────────────────────────────────────────────────────────────────

describe('TaskSessionService.start', () => {
  it('NotFoundException quando task não existe', async () => {
    const prisma = makePrisma({
      task: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const { service } = makeService(prisma);
    await expect(service.start('u-1', 't-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('BadRequestException quando user já tem 3 sessões ativas', async () => {
    const prisma = makePrisma({
      task: { findFirst: jest.fn().mockResolvedValue(TASK_FIXTURE) },
      taskSession: { count: jest.fn().mockResolvedValue(3) },
    });
    const { service } = makeService(prisma);
    await expect(service.start('u-1', 't-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cria sessão running e emite eventos para project/workspace/company', async () => {
    const prisma = makePrisma({
      task: { findFirst: jest.fn().mockResolvedValue(TASK_FIXTURE) },
      taskSession: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue(SESSION_FIXTURE),
      },
    });
    const { service, gateway } = makeService(prisma);

    const result = await service.start('u-1', 't-1');

    expect(result).toBe(SESSION_FIXTURE);
    expect((prisma as any).taskSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 't-1',
          userId: 'u-1',
          status: 'running',
          totalSeconds: 0,
        }),
      }),
    );
    expect(gateway.emitToProject).toHaveBeenCalledWith(
      'p-1',
      'taskSession:started',
      expect.any(Object),
    );
    expect(gateway.emitToWorkspace).toHaveBeenCalledWith(
      'ws-1',
      'taskSession:started',
      expect.any(Object),
    );
    expect(gateway.emitToCompany).toHaveBeenCalledWith(
      'c-1',
      'taskSession:started',
      expect.any(Object),
    );
  });
});

// ── pause ──────────────────────────────────────────────────────────────────────

describe('TaskSessionService.pause', () => {
  it('NotFoundException quando sessão não existe', async () => {
    const prisma = makePrisma({
      taskSession: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const { service } = makeService(prisma);
    await expect(service.pause('u-1', 's-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ForbiddenException quando sessão é de outro user', async () => {
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue({ ...SESSION_FIXTURE, userId: 'outro' }),
      },
    });
    const { service } = makeService(prisma);
    await expect(service.pause('u-1', 's-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('BadRequestException quando sessão não está running', async () => {
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue({ ...SESSION_FIXTURE, status: 'paused' }),
      },
    });
    const { service } = makeService(prisma);
    await expect(service.pause('u-1', 's-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('soma elapsed e persiste status=paused', async () => {
    // resumedAt = NOW - 60s → elapsed = 60s
    const resumedAt = new Date(NOW.getTime() - 60_000);
    const running = { ...SESSION_FIXTURE, resumedAt, totalSeconds: 30 };
    const updated = { ...SESSION_FIXTURE, status: 'paused' as const, totalSeconds: 90 };
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue(running),
        update: jest.fn().mockResolvedValue(updated),
      },
    });
    const { service, gateway } = makeService(prisma);

    const result = await service.pause('u-1', 's-1');

    expect((prisma as any).taskSession.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: expect.objectContaining({ status: 'paused', totalSeconds: 90 }),
      include: expect.any(Object),
    });
    expect(result).toBe(updated);
    expect(gateway.emitToProject).toHaveBeenCalledWith(
      'p-1',
      'taskSession:paused',
      expect.any(Object),
    );
  });
});

// ── resume ─────────────────────────────────────────────────────────────────────

describe('TaskSessionService.resume', () => {
  it('BadRequestException quando sessão não está paused', async () => {
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue({ ...SESSION_FIXTURE, status: 'running' }),
      },
    });
    const { service } = makeService(prisma);
    await expect(service.resume('u-1', 's-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('seta status=running, pausedAt=null e emite eventos', async () => {
    const paused = { ...SESSION_FIXTURE, status: 'paused' as const };
    const updated = { ...SESSION_FIXTURE, status: 'running' as const };
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue(paused),
        update: jest.fn().mockResolvedValue(updated),
      },
    });
    const { service, gateway } = makeService(prisma);

    await service.resume('u-1', 's-1');

    expect((prisma as any).taskSession.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: expect.objectContaining({ status: 'running', pausedAt: null }),
      include: expect.any(Object),
    });
    expect(gateway.emitToProject).toHaveBeenCalledWith(
      'p-1',
      'taskSession:resumed',
      expect.any(Object),
    );
  });
});

// ── stop ───────────────────────────────────────────────────────────────────────

describe('TaskSessionService.stop', () => {
  it('BadRequestException quando sessão já está stopped', async () => {
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue({ ...SESSION_FIXTURE, status: 'stopped' }),
      },
    });
    const { service } = makeService(prisma);
    await expect(service.stop('u-1', 's-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('soma elapsed quando running, persiste stopped e emite eventos', async () => {
    const resumedAt = new Date(NOW.getTime() - 60_000);
    const running = { ...SESSION_FIXTURE, resumedAt, totalSeconds: 30 };
    const updated = { ...SESSION_FIXTURE, status: 'stopped' as const, totalSeconds: 90 };
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue(running),
        update: jest.fn().mockResolvedValue(updated),
      },
    });
    const { service, gateway } = makeService(prisma);

    await service.stop('u-1', 's-1');

    expect((prisma as any).taskSession.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: expect.objectContaining({ status: 'stopped', totalSeconds: 90 }),
      include: expect.any(Object),
    });
    expect(gateway.emitToCompany).toHaveBeenCalledWith(
      'c-1',
      'taskSession:stopped',
      expect.any(Object),
    );
  });

  it('quando sessão estava paused, NÃO recalcula elapsed (mantém totalSeconds)', async () => {
    const paused = { ...SESSION_FIXTURE, status: 'paused' as const, totalSeconds: 120 };
    const prisma = makePrisma({
      taskSession: {
        findFirst: jest.fn().mockResolvedValue(paused),
        update: jest.fn().mockResolvedValue({ ...paused, status: 'stopped' }),
      },
    });
    const { service } = makeService(prisma);

    await service.stop('u-1', 's-1');

    const call = (prisma as any).taskSession.update.mock.calls[0][0];
    expect(call.data.totalSeconds).toBe(120);
  });
});

// ── getMyActive ────────────────────────────────────────────────────────────────

describe('TaskSessionService.getMyActive', () => {
  it('retorna sessões running/paused do usuário', async () => {
    const sessions = [SESSION_FIXTURE];
    const prisma = makePrisma({
      taskSession: { findMany: jest.fn().mockResolvedValue(sessions) },
    });
    const { service } = makeService(prisma);
    const result = await service.getMyActive('u-1');
    expect(result).toBe(sessions);
    expect((prisma as any).taskSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u-1', status: { in: ['running', 'paused'] } },
      }),
    );
  });
});

// ── getWorkspaceActive ─────────────────────────────────────────────────────────

describe('TaskSessionService.getWorkspaceActive', () => {
  it('NotFoundException quando workspace não existe', async () => {
    const prisma = makePrisma({ workspace: { findFirst: jest.fn().mockResolvedValue(null) } });
    const { service } = makeService(prisma);
    await expect(service.getWorkspaceActive('ws-x', 'u-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ForbiddenException quando user não é admin do workspace nem da empresa', async () => {
    const prisma = makePrisma({
      workspace: { findFirst: jest.fn().mockResolvedValue({ companyId: 'c-1' }) },
      membership: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const { service } = makeService(prisma);
    await expect(service.getWorkspaceActive('ws-1', 'u-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('retorna sessões quando user é workspace_admin', async () => {
    const findFirstMembership = jest
      .fn()
      .mockResolvedValueOnce({ id: 'wa-1' }) // wsAdmin
      .mockResolvedValueOnce(null); // companyAdmin
    const sessions = [SESSION_FIXTURE];
    const prisma = makePrisma({
      workspace: { findFirst: jest.fn().mockResolvedValue({ companyId: 'c-1' }) },
      membership: { findFirst: findFirstMembership },
      taskSession: { findMany: jest.fn().mockResolvedValue(sessions) },
    });
    const { service } = makeService(prisma);
    const result = await service.getWorkspaceActive('ws-1', 'u-1');
    expect(result).toBe(sessions);
  });

  it('retorna sessões quando user é company admin', async () => {
    const findFirstMembership = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ca-1' });
    const prisma = makePrisma({
      workspace: { findFirst: jest.fn().mockResolvedValue({ companyId: 'c-1' }) },
      membership: { findFirst: findFirstMembership },
      taskSession: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const { service } = makeService(prisma);
    await expect(service.getWorkspaceActive('ws-1', 'u-1')).resolves.toEqual([]);
  });
});

// ── getCompanyActive ───────────────────────────────────────────────────────────

describe('TaskSessionService.getCompanyActive', () => {
  it('ForbiddenException quando user não é admin da empresa', async () => {
    const prisma = makePrisma({ membership: { findFirst: jest.fn().mockResolvedValue(null) } });
    const { service } = makeService(prisma);
    await expect(service.getCompanyActive('c-1', 'u-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('retorna sessões quando user é admin', async () => {
    const sessions = [SESSION_FIXTURE];
    const prisma = makePrisma({
      membership: { findFirst: jest.fn().mockResolvedValue({ id: 'ca' }) },
      taskSession: { findMany: jest.fn().mockResolvedValue(sessions) },
    });
    const { service } = makeService(prisma);
    expect(await service.getCompanyActive('c-1', 'u-1')).toBe(sessions);
  });
});
