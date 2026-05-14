import { PrismaService } from '../prisma/prisma.service';
import { KanbanGateway } from './kanban.gateway';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makePrisma(
  opts: {
    membershipFindFirst?: jest.Mock;
    workspace?: unknown;
    project?: unknown;
  } = {},
) {
  return {
    membership: { findFirst: opts.membershipFindFirst ?? jest.fn().mockResolvedValue(null) },
    workspace: { findFirst: jest.fn().mockResolvedValue(opts.workspace ?? null) },
    project: { findFirst: jest.fn().mockResolvedValue(opts.project ?? null) },
  } as unknown as PrismaService;
}

function makeMetrics() {
  return { wsConnect: jest.fn(), wsDisconnect: jest.fn(), recordHttp: jest.fn() };
}

function makeGateway(prisma: PrismaService = makePrisma()) {
  const logger = makeLogger();
  const metrics = makeMetrics();
  const gateway = new KanbanGateway(prisma, logger as any, metrics as any);
  const emit = jest.fn();
  (gateway as any).server = {
    to: jest.fn().mockReturnValue({ emit }),
  };
  return { gateway, logger, emit, prisma, metrics };
}

function makeSocket(user: { id: string } = { id: 'u-1' }) {
  return {
    id: 'sock-1',
    data: { user },
    join: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
  } as any;
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

describe('KanbanGateway lifecycle', () => {
  it('afterInit loga inicialização', () => {
    const { gateway, logger } = makeGateway();
    gateway.afterInit();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('inicializado'));
  });

  it('handleConnection/Disconnect logam em debug', () => {
    const { gateway, logger } = makeGateway();
    gateway.handleConnection(makeSocket());
    gateway.handleDisconnect(makeSocket());
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });
});

// ── handleJoinCompany ──────────────────────────────────────────────────────────

describe('KanbanGateway.handleJoinCompany', () => {
  it('emite error quando companyId está ausente', async () => {
    const { gateway } = makeGateway();
    const client = makeSocket();
    await gateway.handleJoinCompany(client, {} as any);
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'companyId é obrigatório' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('emite error quando user não é admin da empresa', async () => {
    const { gateway } = makeGateway(
      makePrisma({ membershipFindFirst: jest.fn().mockResolvedValue(null) }),
    );
    const client = makeSocket();
    await gateway.handleJoinCompany(client, { companyId: 'c-1' });
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Acesso negado à empresa' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('faz join na sala company:<id> e emite joinedCompany quando admin', async () => {
    const { gateway, prisma } = makeGateway(
      makePrisma({ membershipFindFirst: jest.fn().mockResolvedValue({ id: 'm-1' }) }),
    );
    const client = makeSocket();
    await gateway.handleJoinCompany(client, { companyId: 'c-1' });

    expect((prisma as any).membership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u-1',
        resourceType: 'company',
        resourceId: 'c-1',
        role: 'admin',
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(client.join).toHaveBeenCalledWith('company:c-1');
    expect(client.emit).toHaveBeenCalledWith('joinedCompany', { companyId: 'c-1' });
  });
});

// ── handleJoinWorkspace ────────────────────────────────────────────────────────

describe('KanbanGateway.handleJoinWorkspace', () => {
  it('emite error quando workspaceId está ausente', async () => {
    const { gateway } = makeGateway();
    const client = makeSocket();
    await gateway.handleJoinWorkspace(client, {} as any);
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'workspaceId é obrigatório' });
  });

  it('emite error quando workspace não existe', async () => {
    const { gateway } = makeGateway(makePrisma({ workspace: null }));
    const client = makeSocket();
    await gateway.handleJoinWorkspace(client, { workspaceId: 'ws-1' });
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Acesso negado ao workspace' });
  });

  it('emite error quando user não é membro nem admin da empresa', async () => {
    const prisma = makePrisma({
      workspace: { companyId: 'c-1' },
      membershipFindFirst: jest.fn().mockResolvedValue(null),
    });
    const { gateway } = makeGateway(prisma);
    const client = makeSocket();
    await gateway.handleJoinWorkspace(client, { workspaceId: 'ws-1' });
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Acesso negado ao workspace' });
  });

  it('faz join na sala workspace:<id> quando é membro', async () => {
    const prisma = makePrisma({
      workspace: { companyId: 'c-1' },
      // primeiro find (workspace membership) retorna registro; segundo (company admin) é nulo
      membershipFindFirst: jest
        .fn()
        .mockResolvedValueOnce({ id: 'wm' })
        .mockResolvedValueOnce(null),
    });
    const { gateway } = makeGateway(prisma);
    const client = makeSocket();
    await gateway.handleJoinWorkspace(client, { workspaceId: 'ws-1' });

    expect(client.join).toHaveBeenCalledWith('workspace:ws-1');
    expect(client.emit).toHaveBeenCalledWith('joinedWorkspace', { workspaceId: 'ws-1' });
  });

  it('faz join quando é admin da company dona (sem membership direto no workspace)', async () => {
    const prisma = makePrisma({
      workspace: { companyId: 'c-1' },
      membershipFindFirst: jest
        .fn()
        .mockResolvedValueOnce(null) // workspace membership
        .mockResolvedValueOnce({ id: 'ca' }), // company admin
    });
    const { gateway } = makeGateway(prisma);
    const client = makeSocket();
    await gateway.handleJoinWorkspace(client, { workspaceId: 'ws-1' });
    expect(client.join).toHaveBeenCalledWith('workspace:ws-1');
  });
});

// ── handleJoinProject ──────────────────────────────────────────────────────────

describe('KanbanGateway.handleJoinProject', () => {
  it('emite error quando projectId ausente', async () => {
    const { gateway } = makeGateway();
    const client = makeSocket();
    await gateway.handleJoinProject(client, {} as any);
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'projectId é obrigatório' });
  });

  it('emite error quando projeto não existe', async () => {
    const { gateway } = makeGateway(makePrisma({ project: null }));
    const client = makeSocket();
    await gateway.handleJoinProject(client, { projectId: 'p-1' });
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Acesso negado ao projeto' });
  });

  it('faz join na sala project:<id> quando user é membro do workspace', async () => {
    const prisma = makePrisma({
      project: { workspaceId: 'ws-1', workspace: { companyId: 'c-1' } },
      membershipFindFirst: jest
        .fn()
        .mockResolvedValueOnce({ id: 'wm' })
        .mockResolvedValueOnce(null),
    });
    const { gateway } = makeGateway(prisma);
    const client = makeSocket();
    await gateway.handleJoinProject(client, { projectId: 'p-1' });
    expect(client.join).toHaveBeenCalledWith('project:p-1');
    expect(client.emit).toHaveBeenCalledWith('joinedProject', { projectId: 'p-1' });
  });

  it('emite error quando user não tem nenhum membership relevante', async () => {
    const prisma = makePrisma({
      project: { workspaceId: 'ws-1', workspace: { companyId: 'c-1' } },
      membershipFindFirst: jest.fn().mockResolvedValue(null),
    });
    const { gateway } = makeGateway(prisma);
    const client = makeSocket();
    await gateway.handleJoinProject(client, { projectId: 'p-1' });
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Acesso negado ao projeto' });
    expect(client.join).not.toHaveBeenCalled();
  });
});

// ── emit helpers ───────────────────────────────────────────────────────────────

describe('KanbanGateway emit helpers', () => {
  it('emitToProject emite para sala project:<id>', () => {
    const { gateway, emit } = makeGateway();
    gateway.emitToProject('p-1', 'task:moved' as any, { taskId: 't-1' });
    expect((gateway as any).server.to).toHaveBeenCalledWith('project:p-1');
    expect(emit).toHaveBeenCalledWith('task:moved', { taskId: 't-1' });
  });

  it('emitToWorkspace emite para sala workspace:<id>', () => {
    const { gateway, emit } = makeGateway();
    gateway.emitToWorkspace('ws-1', 'task:moved' as any, { x: 1 });
    expect((gateway as any).server.to).toHaveBeenCalledWith('workspace:ws-1');
    expect(emit).toHaveBeenCalledWith('task:moved', { x: 1 });
  });

  it('emitToCompany emite para sala company:<id>', () => {
    const { gateway, emit } = makeGateway();
    gateway.emitToCompany('c-1', 'task:moved' as any, { x: 1 });
    expect((gateway as any).server.to).toHaveBeenCalledWith('company:c-1');
    expect(emit).toHaveBeenCalledWith('task:moved', { x: 1 });
  });
});
