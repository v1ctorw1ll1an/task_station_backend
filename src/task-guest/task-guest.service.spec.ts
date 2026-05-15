import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { TaskGuestRepository } from './task-guest.repository';
import { TaskGuestService } from './task-guest.service';

function makeRepo(
  overrides: Partial<Record<keyof TaskGuestRepository, jest.Mock>> = {},
): jest.Mocked<TaskGuestRepository> {
  return {
    findActiveTaskById: jest.fn(),
    createGuest: jest.fn(),
    listActiveGuestsByTask: jest.fn(),
    findActiveGuestById: jest.fn(),
    softDeleteGuest: jest.fn(),
    findActiveGuestByTokenHash: jest.fn(),
    touchLastAccessed: jest.fn(),
    findPublicTaskById: jest.fn(),
    findColumnByIdInProject: jest.fn(),
    applyPublicTaskUpdate: jest.fn(),
    findProjectWorkspaceId: jest.fn(),
    searchDistinctGuestsInWorkspace: jest.fn(),
    findGuestWithTask: jest.fn(),
    findHistoryEntriesForTask: jest.fn(),
    rotateGuestToken: jest.fn(),
    findColumnNamesByIds: jest.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as jest.Mocked<TaskGuestRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(
  repo: jest.Mocked<TaskGuestRepository>,
  configOverrides: Record<string, unknown> = {},
) {
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        FRONTEND_URL: 'http://localhost:3000',
        ...configOverrides,
      };
      return map[key] ?? fallback;
    }),
    getOrThrow: jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        FRONTEND_URL: 'http://localhost:3000',
        ...configOverrides,
      };
      if (!(key in map)) throw new Error(`Config key ${key} not found`);
      return map[key];
    }),
  } as unknown as ConfigService;
  const logger = makeLogger();
  return { service: new TaskGuestService(repo, configService, logger as any), logger };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return { id: 'task-1', title: 'Implementar feature X', projectId: 'project-1', ...overrides };
}

describe('TaskGuestService.createGuest', () => {
  // Happy path — garante que o fluxo principal funciona: gera token, hasheia, salva, retorna URLs
  it('cria convidado, retorna publicUrl e whatsappUrl com token gerado', async () => {
    const task = makeTask();
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(task),
      createGuest: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          id: 'guest-1',
          taskId: data.taskId,
          name: data.name,
          phoneE164: data.phoneE164,
          email: data.email,
          tokenHash: data.tokenHash,
          invitedById: data.invitedById,
          invitedAt: new Date('2026-05-14T10:00:00Z'),
          lastAccessedAt: null,
          createdAt: new Date('2026-05-14T10:00:00Z'),
          updatedAt: new Date('2026-05-14T10:00:00Z'),
          deletedAt: null,
        }),
      ),
    });
    const { service } = makeService(repo);

    const result = await service.createGuest('task-1', 'user-1', {
      name: 'João Silva',
      phone: '+5511999999999',
    });

    expect(result.guest.id).toBe('guest-1');
    expect(result.guest.name).toBe('João Silva');
    expect(result.guest.phoneE164).toBe('+5511999999999');
    expect(result.guest.email).toBeNull();
    expect(result.publicUrl).toMatch(/^http:\/\/localhost:3000\/public\/task\/[A-Za-z0-9_-]{40,}$/);
    expect(result.whatsappUrl).toMatch(/^https:\/\/wa\.me\/5511999999999\?text=/);
  });

  // Garante que o token salvo no banco é o HASH SHA-256, e o token cru sai apenas na URL pública
  it('salva tokenHash (SHA-256) no repositório e nunca o token cru', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask()),
      createGuest: jest.fn().mockResolvedValue({
        id: 'g1',
        invitedAt: new Date(),
        name: 'A',
        phoneE164: '+5511999999999',
        email: null,
      }),
    });
    const { service } = makeService(repo);

    const result = await service.createGuest('task-1', 'user-1', {
      name: 'A',
      phone: '+5511999999999',
    });

    const rawToken = result.publicUrl.split('/').pop()!;
    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const callArg = repo.createGuest.mock.calls[0][0];
    expect(callArg.tokenHash).toBe(expectedHash);
    expect(callArg.tokenHash).not.toBe(rawToken);
    expect(rawToken.length).toBeGreaterThanOrEqual(40);
  });

  // Garante que email opcional é persistido quando informado
  it('persiste email quando fornecido no DTO', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask()),
      createGuest: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: 'g1', invitedAt: new Date(), ...data }),
        ),
    });
    const { service } = makeService(repo);

    const result = await service.createGuest('task-1', 'user-1', {
      name: 'A',
      phone: '+5511999999999',
      email: 'guest@example.com',
    });

    expect(repo.createGuest.mock.calls[0][0].email).toBe('guest@example.com');
    expect(result.guest.email).toBe('guest@example.com');
  });

  // A URL do WhatsApp contém a mensagem com nome, título da task e link público URL-encoded
  it('monta whatsappUrl com mensagem contendo nome, título da task e publicUrl', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask({ title: 'Tarefa Importante' })),
      createGuest: jest.fn().mockResolvedValue({ id: 'g1', invitedAt: new Date() }),
    });
    const { service } = makeService(repo);

    const result = await service.createGuest('task-1', 'user-1', {
      name: 'Maria',
      phone: '+5511988887777',
    });

    const url = new URL(result.whatsappUrl);
    expect(url.host).toBe('wa.me');
    expect(url.pathname).toBe('/5511988887777');
    const text = url.searchParams.get('text')!;
    expect(text).toContain('Maria');
    expect(text).toContain('Tarefa Importante');
    expect(text).toContain(result.publicUrl);
  });

  // Garante que o whatsappUrl usa apenas dígitos (sem '+', sem espaços) no path do wa.me
  it('strip caracteres não-numéricos do telefone no path do wa.me', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask()),
      createGuest: jest.fn().mockResolvedValue({ id: 'g1', invitedAt: new Date() }),
    });
    const { service } = makeService(repo);

    const result = await service.createGuest('task-1', 'user-1', {
      name: 'A',
      phone: '+55 (11) 99999-8888',
    });

    expect(result.whatsappUrl).toMatch(/^https:\/\/wa\.me\/5511999998888\?/);
  });

  // Telefone com formato inválido deve falhar antes de persistir — proteção contra dado ruim
  it('lança BadRequestException quando telefone não tem formato E.164 válido', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask()),
    });
    const { service } = makeService(repo);

    await expect(
      service.createGuest('task-1', 'user-1', { name: 'A', phone: 'abc' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.createGuest).not.toHaveBeenCalled();
  });

  // Task inexistente ou soft-deletada — não pode criar convidado
  it('lança NotFoundException quando task não existe ou foi soft-deletada', async () => {
    const repo = makeRepo({ findActiveTaskById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(
      service.createGuest('inexistente', 'user-1', { name: 'A', phone: '+5511999999999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.createGuest).not.toHaveBeenCalled();
  });

  // Auditoria/segurança: log estruturado nunca contém token cru, só prefixo do hash
  it('loga criação com guestId/taskId/tokenHashPrefix mas nunca o token cru', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask()),
      createGuest: jest.fn().mockResolvedValue({ id: 'guest-99', invitedAt: new Date() }),
    });
    const { service, logger } = makeService(repo);

    const result = await service.createGuest('task-1', 'user-1', {
      name: 'A',
      phone: '+5511999999999',
    });

    const rawToken = result.publicUrl.split('/').pop()!;
    const allLogPayloads = logger.info.mock.calls
      .map((c) => JSON.stringify(c[0]))
      .concat(logger.debug.mock.calls.map((c) => JSON.stringify(c[0])));
    for (const payload of allLogPayloads) {
      expect(payload).not.toContain(rawToken);
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ guestId: 'guest-99', taskId: 'task-1' }),
      expect.any(String),
    );
  });
});

describe('TaskGuestService.listGuests', () => {
  // Retorna apenas convidados ativos da task (sem token_hash, sem invitedById) — proteção de PII
  it('retorna convidados ativos sem expor tokenHash', async () => {
    const repo = makeRepo({
      listActiveGuestsByTask: jest.fn().mockResolvedValue([
        {
          id: 'g1',
          name: 'João',
          phoneE164: '+5511999999999',
          email: null,
          invitedAt: new Date('2026-05-01T00:00:00Z'),
          lastAccessedAt: null,
        },
      ]),
    });
    const { service } = makeService(repo);

    const result = await service.listGuests('task-1');

    expect(repo.listActiveGuestsByTask).toHaveBeenCalledWith('task-1');
    expect(result).toEqual([
      {
        id: 'g1',
        name: 'João',
        phoneE164: '+5511999999999',
        email: null,
        invitedAt: new Date('2026-05-01T00:00:00Z'),
        lastAccessedAt: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('tokenHash');
  });

  // Task sem convidados retorna array vazio (não 404)
  it('retorna array vazio quando não há convidados', async () => {
    const repo = makeRepo({ listActiveGuestsByTask: jest.fn().mockResolvedValue([]) });
    const { service } = makeService(repo);
    await expect(service.listGuests('task-1')).resolves.toEqual([]);
  });
});

describe('TaskGuestService.revokeGuest', () => {
  // Soft-delete o convidado quando pertence à task — caminho feliz
  it('chama softDelete quando convidado pertence à task', async () => {
    const repo = makeRepo({
      findActiveGuestById: jest.fn().mockResolvedValue({ id: 'g1', taskId: 'task-1' }),
      softDeleteGuest: jest.fn().mockResolvedValue({ id: 'g1' }),
    });
    const { service } = makeService(repo);

    await service.revokeGuest('task-1', 'g1');

    expect(repo.softDeleteGuest).toHaveBeenCalledWith('g1');
  });

  // Convidado inexistente ou já revogado deve falhar com 404 e não deletar nada
  it('lança NotFoundException quando convidado não existe', async () => {
    const repo = makeRepo({ findActiveGuestById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.revokeGuest('task-1', 'g-x')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.softDeleteGuest).not.toHaveBeenCalled();
  });

  // Tentativa de revogar convidado de OUTRA task deve falhar (proteção contra IDOR)
  it('lança NotFoundException quando guest pertence a outra task', async () => {
    const repo = makeRepo({
      findActiveGuestById: jest.fn().mockResolvedValue({ id: 'g1', taskId: 'task-OUTRA' }),
    });
    const { service } = makeService(repo);

    await expect(service.revokeGuest('task-1', 'g1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.softDeleteGuest).not.toHaveBeenCalled();
  });
});

describe('TaskGuestService.getPublicTask', () => {
  const ctx = { guestId: 'g1', taskId: 'task-1' };

  function makePublicTask(overrides: Record<string, unknown> = {}) {
    return {
      id: 'task-1',
      taskNumber: 42,
      title: 'Implementar',
      description: 'Detalhes',
      priority: 'high',
      startDate: new Date('2026-05-01'),
      dueDate: new Date('2026-05-30'),
      order: 1000,
      column: { id: 'col-1', name: 'Em andamento', color: '#fff', isDone: false },
      taskAssignees: [{ user: { name: 'Alice', photoUrl: 'http://x/a.png' } }],
      taskLabels: [{ label: { name: 'urgente', color: '#f00' } }],
      taskChecklists: [{ id: 'c1', title: 'item', completed: false, order: 0 }],
      taskGuests: [
        { id: 'g1', name: 'João Convidado' },
        { id: 'g2', name: 'Maria Convidada' },
      ],
      ...overrides,
    };
  }

  // Happy path: retorna payload com todas as informações permitidas
  it('retorna payload completo e filtrado da task', async () => {
    const repo = makeRepo({
      findPublicTaskById: jest.fn().mockResolvedValue(makePublicTask()),
    });
    const { service } = makeService(repo);

    const result: any = await service.getPublicTask(ctx);

    expect(result.id).toBe('task-1');
    expect(result.taskNumber).toBe(42);
    expect(result.title).toBe('Implementar');
    expect(result.description).toBe('Detalhes');
    expect(result.priority).toBe('high');
    expect(result.column).toEqual({
      id: 'col-1',
      name: 'Em andamento',
      color: '#fff',
      isDone: false,
    });
    expect(result.assignees).toEqual([{ name: 'Alice', photoUrl: 'http://x/a.png' }]);
    expect(result.labels).toEqual([{ name: 'urgente', color: '#f00' }]);
    expect(result.checklists).toEqual([{ id: 'c1', title: 'item', completed: false, order: 0 }]);
    expect(result.permissions).toEqual({ canEdit: true });
  });

  // Segurança: marca o próprio convidado com isYou e omite telefone/email
  it('marca o próprio convidado com isYou e não expõe telefone/email de nenhum guest', async () => {
    const repo = makeRepo({
      findPublicTaskById: jest.fn().mockResolvedValue(makePublicTask()),
    });
    const { service } = makeService(repo);

    const result: any = await service.getPublicTask(ctx);

    expect(result.guests).toEqual([
      { id: 'g1', name: 'João Convidado', isYou: true },
      { id: 'g2', name: 'Maria Convidada', isYou: false },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/phoneE164|phone|email/i);
  });

  // Segurança crítica: payload NÃO contém ids/PII de membros internos
  it('não expõe projectId, reporterId, createdById nem emails de assignees', async () => {
    const repo = makeRepo({
      findPublicTaskById: jest.fn().mockResolvedValue(makePublicTask()),
    });
    const { service } = makeService(repo);
    const result: any = await service.getPublicTask(ctx);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('projectId');
    expect(serialized).not.toContain('reporterId');
    expect(serialized).not.toContain('createdById');
    expect(serialized).not.toContain('userId');
    // garante que não vazou id interno de user nos assignees
    expect(result.assignees[0]).not.toHaveProperty('id');
  });

  // Task que sumiu entre validação do token e o GET (race) — 404 limpo
  it('lança NotFoundException quando task não encontrada', async () => {
    const repo = makeRepo({ findPublicTaskById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.getPublicTask(ctx)).rejects.toBeInstanceOf(NotFoundException);
  });

  // Task sem assignees/labels/checklists/guests → arrays vazios, sem erros
  it('retorna arrays vazios quando task não tem relações', async () => {
    const repo = makeRepo({
      findPublicTaskById: jest.fn().mockResolvedValue(
        makePublicTask({
          taskAssignees: [],
          taskLabels: [],
          taskChecklists: [],
          taskGuests: [],
        }),
      ),
    });
    const { service } = makeService(repo);
    const result: any = await service.getPublicTask(ctx);
    expect(result.assignees).toEqual([]);
    expect(result.labels).toEqual([]);
    expect(result.checklists).toEqual([]);
    expect(result.guests).toEqual([]);
  });
});

describe('TaskGuestService.updatePublicTask', () => {
  const ctx = { guestId: 'g1', taskId: 'task-1', projectId: 'project-1' };

  function repoForUpdate(
    currentTask: Record<string, unknown>,
    opts: Record<string, jest.Mock> = {},
  ) {
    return makeRepo({
      findPublicTaskById: jest.fn().mockResolvedValue({
        id: 'task-1',
        taskNumber: 1,
        title: 'antigo',
        description: 'desc-antiga',
        priority: 'medium',
        startDate: null,
        dueDate: null,
        order: 1000,
        column: { id: 'col-1', name: 'A fazer', color: null, isDone: false },
        taskAssignees: [],
        taskLabels: [],
        taskChecklists: [],
        taskGuests: [{ id: 'g1', name: 'João' }],
        ...currentTask,
      }),
      applyPublicTaskUpdate: jest.fn().mockResolvedValue(undefined),
      findColumnByIdInProject: jest.fn().mockResolvedValue({ id: 'col-2' }),
      ...opts,
    });
  }

  // Happy path: atualiza título e grava entrada de histórico com guestId
  it('atualiza título e grava TaskHistory com guestId (userId null)', async () => {
    const repo = repoForUpdate({ title: 'antigo' });
    const { service } = makeService(repo);

    await service.updatePublicTask(ctx, { title: 'novo título' });

    expect(repo.applyPublicTaskUpdate).toHaveBeenCalledWith(
      'task-1',
      'g1',
      expect.objectContaining({ title: 'novo título' }),
      expect.arrayContaining([
        expect.objectContaining({ field: 'title', oldValue: 'antigo', newValue: 'novo título' }),
      ]),
    );
  });

  // Não grava histórico para campos que não mudaram (e nem chama o update — evita escrita inútil)
  it('não chama applyPublicTaskUpdate quando valor é igual ao atual', async () => {
    const repo = repoForUpdate({ title: 'igual' });
    const { service } = makeService(repo);

    await service.updatePublicTask(ctx, { title: 'igual' });

    expect(repo.applyPublicTaskUpdate).not.toHaveBeenCalled();
  });

  // Mudança de columnId precisa validar que a coluna pertence ao mesmo projeto
  it('valida que columnId pertence ao mesmo projeto', async () => {
    const repo = repoForUpdate({});
    const { service } = makeService(repo);

    await service.updatePublicTask(ctx, { columnId: 'col-2' });

    expect(repo.findColumnByIdInProject).toHaveBeenCalledWith('col-2', 'project-1');
    expect(repo.applyPublicTaskUpdate).toHaveBeenCalledWith(
      'task-1',
      'g1',
      expect.objectContaining({ column: { connect: { id: 'col-2' } } }),
      expect.arrayContaining([
        expect.objectContaining({ field: 'columnId', oldValue: 'col-1', newValue: 'col-2' }),
      ]),
    );
  });

  // Segurança: columnId de outro projeto deve falhar (proteção contra mover task entre projetos)
  it('lança BadRequestException quando columnId é de outro projeto', async () => {
    const repo = repoForUpdate(
      {},
      {
        findColumnByIdInProject: jest.fn().mockResolvedValue(null),
      },
    );
    const { service } = makeService(repo);

    await expect(
      service.updatePublicTask(ctx, { columnId: 'col-de-outro-projeto' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.applyPublicTaskUpdate).not.toHaveBeenCalled();
  });

  // Task sumiu entre validação do token e o PATCH
  it('lança NotFoundException quando task não existe', async () => {
    const repo = makeRepo({
      findPublicTaskById: jest.fn().mockResolvedValue(null),
      applyPublicTaskUpdate: jest.fn(),
    });
    const { service } = makeService(repo);
    await expect(service.updatePublicTask(ctx, { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // DTO vazio (sem nenhum campo) — operação no-op, não chama update
  it('é no-op quando DTO não traz nenhum campo conhecido', async () => {
    const repo = repoForUpdate({});
    const { service } = makeService(repo);
    await service.updatePublicTask(ctx, {});
    expect(repo.applyPublicTaskUpdate).not.toHaveBeenCalled();
  });

  // Após atualizar, retorna payload público fresco (mesma forma do getPublicTask)
  it('retorna payload público atualizado após o update', async () => {
    const repo = repoForUpdate({ title: 'antigo' });
    const { service } = makeService(repo);

    const result: any = await service.updatePublicTask(ctx, { title: 'novo' });

    expect(result).toHaveProperty('id', 'task-1');
    expect(result).toHaveProperty('permissions', { canEdit: true });
    // o repo é chamado 2x para findPublicTaskById: 1 antes do update, 1 depois
    expect(repo.findPublicTaskById).toHaveBeenCalledTimes(2);
  });
});

describe('TaskGuestService.searchGuests', () => {
  // Happy path: resolve workspace do projeto e delega search com q
  it('resolve workspaceId e chama searchDistinctGuestsInWorkspace com q normalizado', async () => {
    const repo = makeRepo({
      findProjectWorkspaceId: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
      searchDistinctGuestsInWorkspace: jest
        .fn()
        .mockResolvedValue([{ name: 'João', phoneE164: '+5511999999999', email: null }]),
    });
    const { service } = makeService(repo);

    const result = await service.searchGuests('project-1', '  jo  ');

    expect(repo.findProjectWorkspaceId).toHaveBeenCalledWith('project-1');
    expect(repo.searchDistinctGuestsInWorkspace).toHaveBeenCalledWith('ws-1', 'jo');
    expect(result).toEqual([{ name: 'João', phoneE164: '+5511999999999', email: null }]);
  });

  // q vazio é aceitável (retorna lista geral)
  it('aceita q vazio e chama o repo com string vazia', async () => {
    const repo = makeRepo({
      findProjectWorkspaceId: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
      searchDistinctGuestsInWorkspace: jest.fn().mockResolvedValue([]),
    });
    const { service } = makeService(repo);

    await service.searchGuests('project-1', '');

    expect(repo.searchDistinctGuestsInWorkspace).toHaveBeenCalledWith('ws-1', '');
  });

  // Projeto inexistente ou soft-deletado — não deve retornar dados (404)
  it('lança NotFoundException quando projeto não existe', async () => {
    const repo = makeRepo({ findProjectWorkspaceId: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.searchGuests('nope', 'x')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.searchDistinctGuestsInWorkspace).not.toHaveBeenCalled();
  });
});

describe('TaskGuestService.buildGuestNotifyUrl', () => {
  function makeGuest(overrides: Record<string, unknown> = {}) {
    return {
      id: 'g1',
      taskId: 'task-1',
      name: 'Maria',
      phoneE164: '+5511988887777',
      tokenHash: 'hash-xyz',
      task: { id: 'task-1', title: 'Tarefa Importante' },
      ...overrides,
    };
  }

  function makeNotifyRepo(overrides: Record<string, jest.Mock> = {}) {
    return makeRepo({
      findGuestWithTask: jest.fn().mockResolvedValue(makeGuest()),
      findHistoryEntriesForTask: jest
        .fn()
        .mockResolvedValue([{ id: 'h1', field: 'title', oldValue: 'antigo', newValue: 'novo' }]),
      rotateGuestToken: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });
  }

  // Happy path: gera wa.me, retorna fields e publicUrl com novo token
  it('retorna whatsappUrl, publicUrl com novo token e lista de fields', async () => {
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest.fn().mockResolvedValue([
        { id: 'h1', field: 'title', oldValue: 'antigo', newValue: 'novo' },
        { id: 'h2', field: 'priority', oldValue: 'low', newValue: 'high' },
      ]),
    });
    const { service } = makeService(repo);

    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1', 'h2']);

    expect(result.fields).toEqual(['title', 'priority']);
    expect(result.publicUrl).toMatch(/^http:\/\/localhost:3000\/public\/task\/[A-Za-z0-9_-]{40,}$/);
    const url = new URL(result.whatsappUrl);
    expect(url.host).toBe('wa.me');
    expect(url.pathname).toBe('/5511988887777');
    const text = url.searchParams.get('text')!;
    expect(text).toContain(result.publicUrl);
  });

  // Re-emite o token: chama rotateGuestToken com novo hash SHA-256 (do token cru contido na publicUrl)
  it('re-emite token via rotateGuestToken usando hash SHA-256 do novo token cru', async () => {
    const rotate = jest.fn().mockResolvedValue(undefined);
    const repo = makeNotifyRepo({ rotateGuestToken: rotate });
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const rawToken = result.publicUrl.split('/').pop()!;
    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    expect(rotate).toHaveBeenCalledWith('g1', expectedHash);
  });

  // Segurança: guest precisa pertencer à task informada (IDOR)
  it('lança NotFoundException quando guestId pertence a outra task', async () => {
    const repo = makeNotifyRepo({
      findGuestWithTask: jest.fn().mockResolvedValue(makeGuest({ taskId: 'OUTRA' })),
    });
    const { service } = makeService(repo);
    await expect(service.buildGuestNotifyUrl('task-1', 'g1', ['h1'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Guest inexistente / revogado
  it('lança NotFoundException quando guest não encontrado', async () => {
    const repo = makeNotifyRepo({ findGuestWithTask: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.buildGuestNotifyUrl('task-1', 'g1', ['h1'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Segurança: history entries de OUTRA task são ignoradas; se zero entradas válidas, 400 e NÃO rotaciona token
  it('lança BadRequestException quando nenhuma entrada de histórico válida sobra', async () => {
    const rotate = jest.fn();
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest.fn().mockResolvedValue([]),
      rotateGuestToken: rotate,
    });
    const { service } = makeService(repo);
    await expect(
      service.buildGuestNotifyUrl('task-1', 'g1', ['hash-de-outra-task']),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rotate).not.toHaveBeenCalled();
  });

  // Diff de campo escalar: mostra valor antigo com ~strikethrough~ e novo com *bold*
  it('renderiza diff de title com ~strikethrough~ e *novo*', async () => {
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest
        .fn()
        .mockResolvedValue([
          { id: 'h1', field: 'title', oldValue: 'Antigo', newValue: 'Novo Título' },
        ]),
    });
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    expect(text).toContain('~"Antigo"~');
    expect(text).toContain('*"Novo Título"*');
  });

  // Diff de description: velho ~strike~, novo *bold* — variantes distintas
  it('description: antigo com ~strike~ e novo com *bold*, separados por seta', async () => {
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest
        .fn()
        .mockResolvedValue([
          { id: 'h1', field: 'description', oldValue: 'velha desc', newValue: 'nova desc' },
        ]),
    });
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    // velho: ~velha desc~ (com til); novo: *nova desc* (com asterisco)
    expect(text).toContain('~velha desc~');
    expect(text).toContain('*nova desc*');
    expect(text).not.toContain('~nova desc~');
    expect(text).not.toContain('*velha desc*');
    // seta entre os blocos
    expect(text).toMatch(/->/);
  });

  // Mapeia valores de priority para rótulos em português
  it('traduz valores de priority para rótulos legíveis', async () => {
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest
        .fn()
        .mockResolvedValue([{ id: 'h1', field: 'priority', oldValue: 'low', newValue: 'urgent' }]),
    });
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    expect(text).toContain('Baixa');
    expect(text).toContain('Urgente');
  });

  // Link público em destaque (antes do rodapé)
  it('inclui o link público em destaque na mensagem (acima do rodapé)', async () => {
    const repo = makeNotifyRepo();
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    const linkIdx = text.indexOf(result.publicUrl);
    const ctaIdx = text.indexOf('taskstation.manyflux');
    expect(linkIdx).toBeGreaterThan(-1);
    expect(ctaIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeLessThan(ctaIdx);
  });

  // Rodapé: separador visual antes da CTA TaskStation
  it('contém separador antes do rodapé com CTA TaskStation', async () => {
    const repo = makeNotifyRepo();
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    expect(text).toMatch(/[-]{8,}/); // separador ASCII compatível com WA Web
    expect(text).toContain('https://taskstation.manyflux.com.br');
  });

  // columnId no histórico é traduzido para o NOME da coluna (não UUID feio)
  it('traduz columnId (UUID) para nome da coluna na mensagem', async () => {
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest
        .fn()
        .mockResolvedValue([
          { id: 'h1', field: 'columnId', oldValue: 'col-uuid-1', newValue: 'col-uuid-2' },
        ]),
      findColumnNamesByIds: jest.fn().mockResolvedValue({
        'col-uuid-1': 'A fazer',
        'col-uuid-2': 'Concluído',
      }),
    });
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    expect(text).toContain('A fazer');
    expect(text).toContain('Concluído');
    expect(text).not.toContain('col-uuid-1');
    expect(text).not.toContain('col-uuid-2');
  });

  // Coluna deletada (não encontrada) cai para "(coluna removida)"
  it('coluna sem registro → "(coluna removida)"', async () => {
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest
        .fn()
        .mockResolvedValue([
          { id: 'h1', field: 'columnId', oldValue: 'col-deletada', newValue: 'col-existe' },
        ]),
      findColumnNamesByIds: jest.fn().mockResolvedValue({ 'col-existe': 'Pronto' }),
    });
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', ['h1']);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    expect(text).toContain('(coluna removida)');
    expect(text).toContain('Pronto');
    expect(text).not.toContain('col-deletada');
  });

  // Renderiza cada tipo de evento de checklist com formato distinto
  it('renderiza fields de checklist (created, completed, uncompleted, renamed, deleted)', async () => {
    const repo = makeNotifyRepo({
      findHistoryEntriesForTask: jest.fn().mockResolvedValue([
        { id: 'h1', field: 'checklist.created', oldValue: null, newValue: 'Item A' },
        { id: 'h2', field: 'checklist.completed', oldValue: null, newValue: 'Item B' },
        { id: 'h3', field: 'checklist.uncompleted', oldValue: null, newValue: 'Item C' },
        { id: 'h4', field: 'checklist.renamed', oldValue: 'velho', newValue: 'novo' },
        { id: 'h5', field: 'checklist.deleted', oldValue: 'Item D', newValue: null },
      ]),
    });
    const { service } = makeService(repo);
    const result = await service.buildGuestNotifyUrl('task-1', 'g1', [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
    ]);
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    expect(text).toMatch(/novo item.*Item A/i);
    expect(text).toContain('[X] *"Item B"*');
    expect(text).toContain('[ ] *"Item C"*');
    expect(text).toContain('~"velho"~');
    expect(text).toContain('*"novo"*');
    expect(text).toContain('removido');
    expect(text).toContain('Item D');
  });

  // Repo é chamado com filtro de taskId — evita vazar entradas de outras tasks
  it('passa taskId para o repo ao buscar history entries', async () => {
    const findHistory = jest
      .fn()
      .mockResolvedValue([{ id: 'h1', field: 'title', oldValue: 'a', newValue: 'b' }]);
    const repo = makeNotifyRepo({ findHistoryEntriesForTask: findHistory });
    const { service } = makeService(repo);
    await service.buildGuestNotifyUrl('task-1', 'g1', ['h1', 'h2']);
    expect(findHistory).toHaveBeenCalledWith('task-1', ['h1', 'h2']);
  });
});

describe('TaskGuestService.createGuest — mensagem de boas-vindas detalhada', () => {
  // A mensagem explica o papel de "convidado", lista o que ele pode fazer, e o intuito
  it('explicita papel de convidado, capacidades e intuito de colaboração', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask({ title: 'Task X' })),
      createGuest: jest.fn().mockResolvedValue({ id: 'g1', invitedAt: new Date() }),
    });
    const { service } = makeService(repo);
    const result = await service.createGuest('task-1', 'user-1', {
      name: 'Carlos',
      phone: '+5511999999999',
    });
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    // papel
    expect(text).toMatch(/convidado/i);
    // capacidades (pelo menos algumas listadas)
    expect(text).toMatch(/Acompanhar/i);
    expect(text).toMatch(/Editar/i);
    expect(text).toMatch(/checklist/i);
    expect(text).toMatch(/colunas|status/i);
    // intuito de colaboração
    expect(text).toMatch(/colabor/i);
    expect(text).toContain(result.publicUrl);
  });
});

describe('TaskGuestService.createGuest — mensagem melhorada (markdown + CTA)', () => {
  // Mensagem de boas-vindas também ganha markdown e CTA com URL em linha própria
  it('whatsappUrl de boas-vindas contém *bold* e URL em linha própria', async () => {
    const repo = makeRepo({
      findActiveTaskById: jest.fn().mockResolvedValue(makeTask({ title: 'Minha Task' })),
      createGuest: jest.fn().mockResolvedValue({ id: 'g1', invitedAt: new Date() }),
    });
    const { service } = makeService(repo);
    const result = await service.createGuest('task-1', 'user-1', {
      name: 'Carlos',
      phone: '+5511999999999',
    });
    const text = new URL(result.whatsappUrl).searchParams.get('text')!;
    expect(text).toMatch(/\*Carlos\*/);
    expect(text).toMatch(/\*Minha Task\*/);
    // URL aparece em linha própria (precedida por quebra de linha e seguida por quebra ou fim)
    expect(text).toMatch(/\n(https?:\/\/[^\s]+)(\n|$)/);
  });
});
