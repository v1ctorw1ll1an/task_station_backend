import { NotificationType, Prisma } from '../generated/prisma/client';
import { NotificacaoGateway } from './notificacao.gateway';
import { NotificacaoRepository } from './notificacao.repository';
import { NotificacaoService, NotifyInput } from './notificacao.service';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeGateway() {
  return { emitToUser: jest.fn() } as unknown as jest.Mocked<NotificacaoGateway>;
}

function makeRepo(
  overrides: Partial<Record<keyof NotificacaoRepository, jest.Mock>> = {},
): jest.Mocked<NotificacaoRepository> {
  return {
    create: jest.fn(),
    createMany: jest.fn(),
    findForUser: jest.fn(),
    countUnread: jest.fn(),
    markAsRead: jest.fn(),
    markAllAsRead: jest.fn(),
    softDelete: jest.fn(),
    clearAll: jest.fn(),
    getOrCreatePreference: jest.fn(),
    updatePreference: jest.fn(),
    findAllActiveUsers: jest.fn(),
    findUserIdsByCompanies: jest.fn(),
    findUserIdsByCompany: jest.fn(),
    findPreferencesForUsers: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<NotificacaoRepository>;
}

function makeService(repoOverrides: Partial<Record<keyof NotificacaoRepository, jest.Mock>> = {}) {
  const repo = makeRepo(repoOverrides);
  const gateway = makeGateway();
  const logger = makeLogger();
  const service = new NotificacaoService(repo, gateway, logger as any);
  return { service, repo, gateway, logger };
}

const DEFAULT_PREF = {
  userId: 'user-1',
  adminBroadcast: true,
  mention: true,
  taskAssigned: true,
  taskComment: true,
  taskUpdated: true,
};

function baseNotify(overrides: Partial<NotifyInput> = {}): NotifyInput {
  return {
    type: NotificationType.TASK_ASSIGNED,
    recipientId: 'user-1',
    title: 'Você foi atribuído',
    body: 'Task X',
    ...overrides,
  };
}

// ── notify ─────────────────────────────────────────────────────────────────────

describe('NotificacaoService.notify', () => {
  it('não notifica quando actorId == recipientId', async () => {
    const { service, repo, gateway } = makeService();
    await service.notify(baseNotify({ actorId: 'user-1', recipientId: 'user-1' }));
    expect(repo.getOrCreatePreference).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });

  it('não notifica quando preferência do tipo está desligada', async () => {
    const { service, repo, gateway } = makeService({
      getOrCreatePreference: jest.fn().mockResolvedValue({ ...DEFAULT_PREF, taskAssigned: false }),
    });
    await service.notify(baseNotify({ type: NotificationType.TASK_ASSIGNED }));
    expect(repo.create).not.toHaveBeenCalled();
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });

  it('persiste notificação e emite via gateway com payload completo', async () => {
    const created = { id: 'n-1', type: NotificationType.TASK_ASSIGNED };
    const { service, repo, gateway } = makeService({
      getOrCreatePreference: jest.fn().mockResolvedValue(DEFAULT_PREF),
      create: jest.fn().mockResolvedValue(created),
    });

    await service.notify(
      baseNotify({
        actorId: 'actor-1',
        taskId: 'task-1',
        projectId: 'proj-1',
        metadata: { foo: 'bar' },
      }),
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: { connect: { id: 'user-1' } },
        actor: { connect: { id: 'actor-1' } },
        task: { connect: { id: 'task-1' } },
        project: { connect: { id: 'proj-1' } },
        type: NotificationType.TASK_ASSIGNED,
        metadata: { foo: 'bar' },
      }),
    );
    expect(gateway.emitToUser).toHaveBeenCalledWith('user-1', 'notification:new', created);
  });

  it('omite connects opcionais quando não fornecidos', async () => {
    const { service, repo } = makeService({
      getOrCreatePreference: jest.fn().mockResolvedValue(DEFAULT_PREF),
      create: jest.fn().mockResolvedValue({ id: 'n-1' }),
    });
    await service.notify(baseNotify());
    const arg = repo.create.mock.calls[0][0];
    expect(arg).not.toHaveProperty('actor');
    expect(arg).not.toHaveProperty('task');
    expect(arg).not.toHaveProperty('project');
    expect(arg).not.toHaveProperty('metadata');
  });
});

// ── notifyMany ─────────────────────────────────────────────────────────────────

describe('NotificacaoService.notifyMany', () => {
  it('retorna cedo quando lista é vazia', async () => {
    const { service, repo } = makeService();
    await service.notifyMany([]);
    expect(repo.findPreferencesForUsers).not.toHaveBeenCalled();
    expect(repo.createMany).not.toHaveBeenCalled();
  });

  it('filtra self-notifications (actorId == recipientId)', async () => {
    const { service, repo } = makeService({
      findPreferencesForUsers: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    await service.notifyMany([
      baseNotify({ recipientId: 'u-1', actorId: 'u-1' }),
      baseNotify({ recipientId: 'u-2', actorId: 'u-1' }),
    ]);
    // u-1 é self → restou só u-2
    expect(repo.findPreferencesForUsers).toHaveBeenCalledWith(['u-2']);
  });

  it('quando todos forem self, não chama nada', async () => {
    const { service, repo } = makeService();
    await service.notifyMany([baseNotify({ recipientId: 'u-1', actorId: 'u-1' })]);
    expect(repo.findPreferencesForUsers).not.toHaveBeenCalled();
    expect(repo.createMany).not.toHaveBeenCalled();
  });

  it('respeita preferências por usuário (drop quando tipo está off)', async () => {
    const { service, repo, gateway } = makeService({
      findPreferencesForUsers: jest.fn().mockResolvedValue([
        { ...DEFAULT_PREF, userId: 'u-1', taskAssigned: true },
        { ...DEFAULT_PREF, userId: 'u-2', taskAssigned: false },
      ]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    await service.notifyMany([
      baseNotify({ recipientId: 'u-1', type: NotificationType.TASK_ASSIGNED }),
      baseNotify({ recipientId: 'u-2', type: NotificationType.TASK_ASSIGNED }),
    ]);

    expect(repo.createMany).toHaveBeenCalledTimes(1);
    const rows = repo.createMany.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipientId: 'u-1' });
    expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
    expect(gateway.emitToUser).toHaveBeenCalledWith(
      'u-1',
      'notification:new',
      expect.objectContaining({ type: NotificationType.TASK_ASSIGNED }),
    );
  });

  it('assume defaults TRUE quando não existe linha de preferência', async () => {
    const { service, repo } = makeService({
      findPreferencesForUsers: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    await service.notifyMany([baseNotify({ recipientId: 'u-novo' })]);
    expect(repo.createMany).toHaveBeenCalledTimes(1);
  });

  it('usa Prisma.JsonNull quando metadata é ausente', async () => {
    const { service, repo } = makeService({
      findPreferencesForUsers: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    await service.notifyMany([baseNotify({ recipientId: 'u-1' })]);
    const rows = repo.createMany.mock.calls[0][0];
    expect(rows[0].metadata).toBe(Prisma.JsonNull);
  });
});

// ── broadcast ──────────────────────────────────────────────────────────────────

describe('NotificacaoService.broadcast', () => {
  it('quando targetUserId é fornecido, faz notify único', async () => {
    const { service, repo } = makeService({
      getOrCreatePreference: jest.fn().mockResolvedValue(DEFAULT_PREF),
      create: jest.fn().mockResolvedValue({ id: 'n' }),
    });
    await service.broadcast('actor', 'T', 'B', 'target-1');
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.findUserIdsByCompanies).not.toHaveBeenCalled();
    expect(repo.findAllActiveUsers).not.toHaveBeenCalled();
  });

  it('quando companyIds fornecido, busca usuários e usa notifyMany', async () => {
    const { service, repo } = makeService({
      findUserIdsByCompanies: jest.fn().mockResolvedValue(['u-1', 'u-2']),
      findPreferencesForUsers: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    });
    await service.broadcast('actor', 'T', 'B', undefined, ['comp-1']);
    expect(repo.findUserIdsByCompanies).toHaveBeenCalledWith(['comp-1']);
    expect(repo.createMany).toHaveBeenCalledTimes(1);
    expect(repo.findAllActiveUsers).not.toHaveBeenCalled();
  });

  it('sem target nem companyIds, faz broadcast global', async () => {
    const { service, repo } = makeService({
      findAllActiveUsers: jest.fn().mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]),
      findPreferencesForUsers: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    });
    await service.broadcast('actor', 'T', 'B');
    expect(repo.findAllActiveUsers).toHaveBeenCalled();
    expect(repo.createMany).toHaveBeenCalledTimes(1);
  });
});

// ── broadcastToCompany ─────────────────────────────────────────────────────────

describe('NotificacaoService.broadcastToCompany', () => {
  it('repassa workspaceIds para findUserIdsByCompany', async () => {
    const { service, repo } = makeService({
      findUserIdsByCompany: jest.fn().mockResolvedValue(['u-1']),
      findPreferencesForUsers: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    await service.broadcastToCompany('actor', 'comp-1', 'T', 'B', ['ws-1', 'ws-2']);
    expect(repo.findUserIdsByCompany).toHaveBeenCalledWith('comp-1', ['ws-1', 'ws-2']);
    expect(repo.createMany).toHaveBeenCalledTimes(1);
  });

  it('funciona sem workspaceIds', async () => {
    const { service, repo } = makeService({
      findUserIdsByCompany: jest.fn().mockResolvedValue([]),
    });
    await service.broadcastToCompany('actor', 'comp-1', 'T', 'B');
    expect(repo.findUserIdsByCompany).toHaveBeenCalledWith('comp-1', undefined);
    expect(repo.createMany).not.toHaveBeenCalled();
  });
});

// ── listForUser ────────────────────────────────────────────────────────────────

describe('NotificacaoService.listForUser', () => {
  it('retorna paginação no formato { data, total, page, limit }', async () => {
    const { service, repo } = makeService({
      findForUser: jest.fn().mockResolvedValue([[{ id: 'n-1' }], 7]),
    });
    const result = await service.listForUser('u-1', 2, 10, false);
    expect(repo.findForUser).toHaveBeenCalledWith('u-1', 2, 10, false);
    expect(result).toEqual({ data: [{ id: 'n-1' }], total: 7, page: 2, limit: 10 });
  });

  it('repassa unreadOnly=true ao repo', async () => {
    const { service, repo } = makeService({
      findForUser: jest.fn().mockResolvedValue([[], 0]),
    });
    await service.listForUser('u-1', 1, 20, true);
    expect(repo.findForUser).toHaveBeenCalledWith('u-1', 1, 20, true);
  });
});

// ── countUnread ────────────────────────────────────────────────────────────────

describe('NotificacaoService.countUnread', () => {
  it('embrulha resultado em { count }', async () => {
    const { service } = makeService({ countUnread: jest.fn().mockResolvedValue(5) });
    expect(await service.countUnread('u-1')).toEqual({ count: 5 });
  });
});

// ── markAsRead / markAllAsRead / delete / clearAll ─────────────────────────────

describe('NotificacaoService.markAsRead', () => {
  it('repassa id+userId ao repo', async () => {
    const { service, repo } = makeService({
      markAsRead: jest.fn().mockResolvedValue({ count: 1 }),
    });
    await service.markAsRead('n-1', 'u-1');
    expect(repo.markAsRead).toHaveBeenCalledWith('n-1', 'u-1');
  });
});

describe('NotificacaoService.markAllAsRead', () => {
  it('repassa userId ao repo', async () => {
    const { service, repo } = makeService({
      markAllAsRead: jest.fn().mockResolvedValue({ count: 3 }),
    });
    await service.markAllAsRead('u-1');
    expect(repo.markAllAsRead).toHaveBeenCalledWith('u-1');
  });
});

describe('NotificacaoService.deleteNotification', () => {
  it('chama softDelete com id+userId', async () => {
    const { service, repo } = makeService({
      softDelete: jest.fn().mockResolvedValue({ count: 1 }),
    });
    await service.deleteNotification('n-1', 'u-1');
    expect(repo.softDelete).toHaveBeenCalledWith('n-1', 'u-1');
  });
});

describe('NotificacaoService.clearAll', () => {
  it('chama clearAll do repo', async () => {
    const { service, repo } = makeService({ clearAll: jest.fn().mockResolvedValue({ count: 5 }) });
    await service.clearAll('u-1');
    expect(repo.clearAll).toHaveBeenCalledWith('u-1');
  });
});

// ── preferences ────────────────────────────────────────────────────────────────

describe('NotificacaoService.getPreference', () => {
  it('retorna preferência via getOrCreate', async () => {
    const { service } = makeService({
      getOrCreatePreference: jest.fn().mockResolvedValue(DEFAULT_PREF),
    });
    expect(await service.getPreference('u-1')).toEqual(DEFAULT_PREF);
  });
});

describe('NotificacaoService.updatePreference', () => {
  it('repassa DTO ao repo.updatePreference', async () => {
    const updated = { ...DEFAULT_PREF, taskComment: false };
    const { service, repo } = makeService({
      updatePreference: jest.fn().mockResolvedValue(updated),
    });
    const dto = { taskComment: false };
    const result = await service.updatePreference('u-1', dto);
    expect(repo.updatePreference).toHaveBeenCalledWith('u-1', dto);
    expect(result).toBe(updated);
  });
});
