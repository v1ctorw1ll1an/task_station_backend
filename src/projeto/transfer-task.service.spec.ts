import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { TaskPriority } from '../generated/prisma/client';
import { ProjetoRepository } from './projeto.repository';
import { ProjetoService } from './projeto.service';
import { TransferTaskDto } from './dto/transfer-task.dto';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Task Original',
    description: 'Descrição da task',
    priority: TaskPriority.high,
    order: 1000,
    taskNumber: 5,
    dueDate: new Date('2026-06-01'),
    startDate: new Date('2026-05-01'),
    columnId: 'col-src-1',
    projectId: 'project-src',
    updatedAt: new Date(),
    reporterId: 'user-reporter',
    createdById: 'user-creator',
    taskAssignees: [
      { user: { id: 'user-a', name: 'Alice', email: 'alice@test.com', photoUrl: null } },
      { user: { id: 'user-b', name: 'Bob', email: 'bob@test.com', photoUrl: null } },
    ],
    taskLabels: [
      { label: { id: 'label-1', name: 'Bug', color: '#ef4444' } },
      { label: { id: 'label-2', name: 'Urgente', color: '#f59e0b' } },
    ],
    reporter: { id: 'user-reporter', name: 'Reporter', email: 'reporter@test.com', photoUrl: null },
    _count: { taskComments: 2 },
    ...overrides,
  };
}

function makeTaskWithRelations(overrides: Record<string, unknown> = {}) {
  return {
    ...makeTask(),
    taskComments: [
      {
        id: 'comment-1',
        userId: 'user-a',
        content: 'Primeiro comentário',
        createdAt: new Date('2026-05-10'),
      },
      {
        id: 'comment-2',
        userId: 'user-b',
        content: 'Segundo comentário',
        createdAt: new Date('2026-05-11'),
      },
    ],
    taskAttachments: [
      {
        id: 'att-1',
        uploadedById: 'user-a',
        originalName: 'screenshot.png',
        storedName: 'abc123.webp',
        mimeType: 'image/webp',
        size: 1024,
        hasThumbnail: true,
      },
    ],
    taskHistory: [
      {
        id: 'hist-1',
        taskId: 'task-1',
        userId: 'user-a',
        field: 'title',
        oldValue: 'Título antigo',
        newValue: 'Task Original',
        changedAt: new Date('2026-05-05'),
      },
    ],
    ...overrides,
  } as never;
}

function makeProjectInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-target',
    name: 'Projeto Destino',
    workspaceId: 'ws-target',
    taskCounter: 10,
    workspace: { id: 'ws-target', companyId: 'company-1', name: 'Workspace Destino' },
    ...overrides,
  };
}

function makeNewTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'new-task-1',
    title: 'Task Original',
    description: 'Descrição da task',
    priority: TaskPriority.high,
    order: 2000,
    taskNumber: 11,
    dueDate: new Date('2026-06-01'),
    startDate: new Date('2026-05-01'),
    columnId: 'col-target-1',
    projectId: 'project-target',
    updatedAt: new Date(),
    taskAssignees: [],
    taskLabels: [],
    reporter: {
      id: 'user-performer',
      name: 'Performer',
      email: 'performer@test.com',
      photoUrl: null,
    },
    _count: { taskComments: 0 },
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof ProjetoRepository, jest.Mock>> = {},
): jest.Mocked<ProjetoRepository> {
  return {
    findProjectById: jest.fn(),
    findColumnById: jest.fn(),
    findColumnsByProject: jest.fn(),
    countActiveTasksInColumn: jest.fn(),
    createColuna: jest.fn(),
    updateColuna: jest.fn(),
    softDeleteColunaWithMigration: jest.fn(),
    reorderColunas: jest.fn(),
    findTaskById: jest.fn(),
    findTasksByColumn: jest.fn(),
    findAllTasksByProject: jest.fn(),
    createTask: jest.fn(),
    updateTask: jest.fn(),
    updateTaskAssignees: jest.fn(),
    updateTaskLabels: jest.fn(),
    softDeleteTask: jest.fn(),
    moveTask: jest.fn(),
    getKanban: jest.fn(),
    getProjectLastModifiedAt: jest.fn(),
    createTaskHistories: jest.fn().mockResolvedValue({ count: 1 }),
    findDeletedTaskById: jest.fn(),
    findDeletedTasks: jest.fn(),
    restoreTask: jest.fn(),
    findWorkspaceMembersByProject: jest.fn(),
    findLabelsByProject: jest.fn(),
    findLabelById: jest.fn(),
    createLabel: jest.fn(),
    updateLabel: jest.fn(),
    softDeleteLabel: jest.fn(),
    findCommentsByTask: jest.fn(),
    findCommentById: jest.fn(),
    createComment: jest.fn(),
    updateComment: jest.fn(),
    softDeleteComment: jest.fn(),
    getTaskHistory: jest.fn(),
    createAttachment: jest.fn(),
    findAttachments: jest.fn(),
    findAttachmentById: jest.fn(),
    softDeleteAttachment: jest.fn(),
    countAttachments: jest.fn(),
    // Transfer methods
    findTaskWithFullRelations: jest.fn(),
    findProjectWithWorkspaceInfo: jest.fn(),
    findMatchingLabelsByName: jest.fn(),
    createTransferredTask: jest.fn(),
    findAccessibleProjects: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<ProjetoRepository>;
}

function makePrismaService() {
  return {
    membership: {
      findFirst: jest.fn(),
    },
    projectRestriction: {
      findUnique: jest.fn(),
    },
  };
}

function makeService(
  repo: jest.Mocked<ProjetoRepository>,
  prismaOverrides?: ReturnType<typeof makePrismaService>,
) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const kanbanGateway = { emitToProject: jest.fn() };
  const notificacaoService = { notify: jest.fn().mockResolvedValue(undefined) };
  const prismaService = prismaOverrides ?? makePrismaService();

  const service = new ProjetoService(
    repo,
    kanbanGateway as never,
    notificacaoService as never,
    prismaService as never,
    logger as never,
  );

  return { service, kanbanGateway, notificacaoService, prismaService };
}

function baseDto(overrides: Partial<TransferTaskDto> = {}): TransferTaskDto {
  return {
    mode: 'copy',
    targetProjectId: 'project-target',
    targetColumnId: 'col-target-1',
    includeAssignees: false,
    includeLabels: 'skip',
    includeComments: false,
    includeAttachments: false,
    includeHistory: false,
    includeDates: true,
    ...overrides,
  };
}

// ── Setup helper to avoid boilerplate ──────────────────────────────────────────

function setupValidTransfer(
  repo: jest.Mocked<ProjetoRepository>,
  prisma: ReturnType<typeof makePrismaService>,
) {
  repo.findTaskWithFullRelations.mockResolvedValue(makeTaskWithRelations());
  repo.findProjectWithWorkspaceInfo
    .mockResolvedValueOnce(makeProjectInfo()) // target project
    .mockResolvedValueOnce({
      // source project
      id: 'project-src',
      name: 'Projeto Origem',
      workspaceId: 'ws-src',
      taskCounter: 5,
      workspace: { id: 'ws-src', companyId: 'company-1', name: 'Workspace Origem' },
    } as never);
  repo.findColumnById.mockResolvedValue({
    id: 'col-target-1',
    name: 'A Fazer',
    color: null,
    order: 1000,
    projectId: 'project-target',
  });
  repo.findWorkspaceMembersByProject.mockResolvedValue([
    { id: 'user-a', name: 'Alice', email: 'alice@test.com', photoUrl: null },
    { id: 'user-performer', name: 'Performer', email: 'performer@test.com', photoUrl: null },
  ]);
  repo.createTransferredTask.mockResolvedValue(makeNewTask());
  repo.findMatchingLabelsByName.mockResolvedValue([]);

  // Allow access to target project
  prisma.membership.findFirst
    .mockResolvedValueOnce({ role: 'member' }) // workspace membership
    .mockResolvedValueOnce(null); // company admin (not)
}

// ── testes ─────────────────────────────────────────────────────────────────────

describe('ProjetoService — transferTask', () => {
  // ── Access control ────────────────────────────────────────────────────────

  describe('access control', () => {
    it('rejeita quando task fonte não existe', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findTaskWithFullRelations.mockResolvedValue(null);

      await expect(
        service.transferTask('project-src', 'task-1', baseDto(), 'user-performer'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejeita quando projeto destino não existe', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findTaskWithFullRelations.mockResolvedValue(makeTask() as never);
      repo.findProjectWithWorkspaceInfo.mockResolvedValue(null);

      await expect(
        service.transferTask('project-src', 'task-1', baseDto(), 'user-performer'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejeita quando projeto destino é o mesmo que o de origem', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findTaskWithFullRelations.mockResolvedValue(makeTask() as never);
      repo.findProjectWithWorkspaceInfo.mockResolvedValue(makeProjectInfo({ id: 'project-src' }));

      await expect(
        service.transferTask(
          'project-src',
          'task-1',
          baseDto({ targetProjectId: 'project-src' }),
          'user-performer',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita quando usuário não tem membership no workspace do projeto destino', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findTaskWithFullRelations.mockResolvedValue(makeTask() as never);
      repo.findProjectWithWorkspaceInfo.mockResolvedValue(makeProjectInfo());

      prisma.membership.findFirst
        .mockResolvedValueOnce(null) // no workspace membership
        .mockResolvedValueOnce(null); // no company admin

      await expect(
        service.transferTask('project-src', 'task-1', baseDto(), 'user-performer'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejeita quando usuário está na ProjectRestriction do projeto destino', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findTaskWithFullRelations.mockResolvedValue(makeTask() as never);
      repo.findProjectWithWorkspaceInfo.mockResolvedValue(makeProjectInfo());

      prisma.membership.findFirst
        .mockResolvedValueOnce({ role: 'member' }) // workspace membership (member, not admin)
        .mockResolvedValueOnce(null); // no company admin
      prisma.projectRestriction.findUnique.mockResolvedValue({ id: 'restriction-1' });

      await expect(
        service.transferTask('project-src', 'task-1', baseDto(), 'user-performer'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('permite quando usuário é company admin do projeto destino', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findTaskWithFullRelations.mockResolvedValue(makeTaskWithRelations());
      repo.findProjectWithWorkspaceInfo
        .mockResolvedValueOnce(makeProjectInfo())
        .mockResolvedValueOnce({
          id: 'project-src',
          name: 'Projeto Origem',
          workspaceId: 'ws-src',
          taskCounter: 5,
          workspace: { id: 'ws-src', companyId: 'company-1', name: 'Workspace Origem' },
        } as never);
      repo.findColumnById.mockResolvedValue({
        id: 'col-target-1',
        name: 'A Fazer',
        color: null,
        order: 1000,
        projectId: 'project-target',
      });
      repo.findWorkspaceMembersByProject.mockResolvedValue([]);
      repo.createTransferredTask.mockResolvedValue(makeNewTask());

      // Company admin — no workspace membership
      prisma.membership.findFirst
        .mockResolvedValueOnce(null) // no workspace membership
        .mockResolvedValueOnce({ id: 'admin-member' }); // company admin

      await expect(
        service.transferTask('project-src', 'task-1', baseDto(), 'user-performer'),
      ).resolves.toBeDefined();
    });

    it('rejeita quando coluna destino não existe', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findTaskWithFullRelations.mockResolvedValue(makeTask() as never);
      repo.findProjectWithWorkspaceInfo.mockResolvedValue(makeProjectInfo());
      repo.findColumnById.mockResolvedValue(null);

      prisma.membership.findFirst
        .mockResolvedValueOnce({ role: 'member' })
        .mockResolvedValueOnce(null);

      await expect(
        service.transferTask('project-src', 'task-1', baseDto(), 'user-performer'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Copy mode ────────────────────────────────────────────────────────────

  describe('copy mode', () => {
    it('cria nova task no projeto destino preservando dados básicos', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      const result = await service.transferTask(
        'project-src',
        'task-1',
        baseDto(),
        'user-performer',
      );

      expect(result.task).toBeDefined();
      expect(repo.createTransferredTask).toHaveBeenCalledTimes(1);

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.targetProjectId).toBe('project-target');
      expect(callArgs.targetColumnId).toBe('col-target-1');
      expect(callArgs.title).toBe('Task Original');
      expect(callArgs.description).toBe('Descrição da task');
      expect(callArgs.priority).toBe(TaskPriority.high);
      expect(callArgs.reporterId).toBe('user-performer');
      expect(callArgs.createdById).toBe('user-performer');
    });

    it('NÃO soft-deleta a task fonte no modo copy', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ mode: 'copy' }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.softDeleteSourceTaskId).toBeNull();
    });

    it('preserva datas quando includeDates é true (default)', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask('project-src', 'task-1', baseDto(), 'user-performer');

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.startDate).toEqual(new Date('2026-05-01'));
      expect(callArgs.dueDate).toEqual(new Date('2026-06-01'));
    });

    it('remove datas quando includeDates é false', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeDates: false }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.startDate).toBeNull();
      expect(callArgs.dueDate).toBeNull();
    });

    it('emite task:created apenas no projeto destino (copy)', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service, kanbanGateway } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask('project-src', 'task-1', baseDto(), 'user-performer');

      expect(kanbanGateway.emitToProject).toHaveBeenCalledWith(
        'project-target',
        'task:created',
        expect.objectContaining({ task: expect.any(Object), columnId: 'col-target-1' }),
      );
      // Should NOT emit task:deleted on source
      expect(kanbanGateway.emitToProject).not.toHaveBeenCalledWith(
        'project-src',
        'task:deleted',
        expect.any(Object),
      );
    });
  });

  // ── Cut mode ─────────────────────────────────────────────────────────────

  describe('cut mode', () => {
    it('soft-deleta a task fonte no modo cut', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ mode: 'cut' }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.softDeleteSourceTaskId).toBe('task-1');
    });

    it('emite task:deleted no projeto fonte + task:created no destino (cut)', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service, kanbanGateway } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ mode: 'cut' }),
        'user-performer',
      );

      expect(kanbanGateway.emitToProject).toHaveBeenCalledWith(
        'project-target',
        'task:created',
        expect.any(Object),
      );
      expect(kanbanGateway.emitToProject).toHaveBeenCalledWith(
        'project-src',
        'task:deleted',
        expect.objectContaining({ taskId: 'task-1', columnId: 'col-src-1' }),
      );
    });

    it('adiciona entry transferred_from no histórico', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ mode: 'cut' }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.transferHistoryEntry.field).toBe('transferred_from');
      expect(callArgs.transferHistoryEntry.oldValue).toBe('Projeto Origem');
      expect(callArgs.transferHistoryEntry.newValue).toBe('Projeto Destino');
    });
  });

  // ── Assignees ────────────────────────────────────────────────────────────

  describe('assignees', () => {
    it('pula assignees que não são membros do workspace destino', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      // user-a é membro, user-b NÃO é membro do workspace destino
      const result = await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeAssignees: true }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.assigneeIds).toEqual(['user-a']);
      expect(result.skippedAssignees).toEqual(['Bob']);
    });

    it('funciona quando todos os assignees são inválidos', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      // Nenhum membro no workspace destino
      repo.findWorkspaceMembersByProject.mockResolvedValue([]);

      const result = await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeAssignees: true }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.assigneeIds).toEqual([]);
      expect(result.skippedAssignees).toEqual(['Alice', 'Bob']);
    });

    it('não copia assignees quando includeAssignees é false', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeAssignees: false }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.assigneeIds).toEqual([]);
    });

    it('funciona quando todos os assignees são válidos', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      // Ambos os assignees são membros
      repo.findWorkspaceMembersByProject.mockResolvedValue([
        { id: 'user-a', name: 'Alice', email: 'alice@test.com', photoUrl: null },
        { id: 'user-b', name: 'Bob', email: 'bob@test.com', photoUrl: null },
        { id: 'user-performer', name: 'Performer', email: 'performer@test.com', photoUrl: null },
      ]);

      const result = await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeAssignees: true }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.assigneeIds).toEqual(['user-a', 'user-b']);
      expect(result.skippedAssignees).toEqual([]);
    });
  });

  // ── Labels ───────────────────────────────────────────────────────────────

  describe('labels', () => {
    it('skip: não inclui nenhuma label', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeLabels: 'skip' }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.labelIds).toEqual([]);
    });

    it('match: encontra labels por nome no destino, ignora sem match', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      // Apenas 'Bug' existe no destino
      repo.findMatchingLabelsByName.mockResolvedValue([
        { id: 'label-target-1', name: 'Bug', color: '#ef4444', projectId: 'project-target' },
      ]);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeLabels: 'match' }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.labelIds).toEqual(['label-target-1']);
    });

    it('create: cria labels que não existem no destino, reutiliza existentes', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      // 'Bug' existe, 'Urgente' não
      repo.findMatchingLabelsByName.mockResolvedValue([
        { id: 'label-target-1', name: 'Bug', color: '#ef4444', projectId: 'project-target' },
      ]);
      repo.createLabel.mockResolvedValue({
        id: 'label-target-new',
        name: 'Urgente',
        color: '#f59e0b',
        projectId: 'project-target',
      });

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeLabels: 'create' }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.labelIds).toEqual(['label-target-1', 'label-target-new']);
      expect(repo.createLabel).toHaveBeenCalledWith({
        projectId: 'project-target',
        name: 'Urgente',
        color: '#f59e0b',
      });
    });
  });

  // ── Comments ─────────────────────────────────────────────────────────────

  describe('comments', () => {
    it('copia comments preservando userId quando includeComments é true', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeComments: true }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.comments).toHaveLength(2);
      expect(callArgs.comments[0].userId).toBe('user-a');
      expect(callArgs.comments[0].content).toBe('Primeiro comentário');
    });

    it('não copia comments quando includeComments é false', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeComments: false }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.comments).toEqual([]);
    });
  });

  // ── Attachments ──────────────────────────────────────────────────────────

  describe('attachments', () => {
    it('inclui registros de attachments quando includeAttachments é true', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeAttachments: true }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.attachments).toHaveLength(1);
      expect(callArgs.attachments[0].originalName).toBe('screenshot.png');
    });

    it('não inclui attachments quando includeAttachments é false', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeAttachments: false }),
        'user-performer',
      );

      const callArgs = repo.createTransferredTask.mock.calls[0][0];
      expect(callArgs.attachments).toEqual([]);
    });
  });

  // ── Notifications ────────────────────────────────────────────────────────

  describe('notifications', () => {
    it('envia TASK_ASSIGNED para assignees válidos (exceto performer)', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service, notificacaoService } = makeService(repo, prisma);
      setupValidTransfer(repo, prisma);

      // user-a é membro do destino
      await service.transferTask(
        'project-src',
        'task-1',
        baseDto({ includeAssignees: true }),
        'user-performer',
      );

      expect(notificacaoService.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TASK_ASSIGNED',
          recipientId: 'user-a',
          actorId: 'user-performer',
        }),
      );
    });
  });

  // ── getTransferTargets ────────────────────────────────────────────────────

  describe('getTransferTargets', () => {
    it('retorna projetos agrupados por workspace', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findProjectById.mockResolvedValue({
        id: 'project-src',
        workspaceId: 'ws-1',
        isActive: true,
      });
      repo.findAccessibleProjects.mockResolvedValue([
        {
          id: 'proj-a',
          name: 'Projeto A',
          workspaceId: 'ws-1',
          workspace: { name: 'Workspace 1' },
          columns: [{ id: 'col-1', name: 'To Do' }],
        },
        {
          id: 'proj-b',
          name: 'Projeto B',
          workspaceId: 'ws-2',
          workspace: { name: 'Workspace 2' },
          columns: [{ id: 'col-2', name: 'Backlog' }],
        },
      ] as never);

      const result = await service.getTransferTargets('project-src', 'user-1');

      expect(result).toHaveLength(2);
      expect(result[0].workspaceName).toBe('Workspace 1');
      expect(result[0].projects).toHaveLength(1);
      expect(result[1].workspaceName).toBe('Workspace 2');
    });

    it('lança NotFoundException se projeto não existe', async () => {
      const repo = makeRepo();
      const prisma = makePrismaService();
      const { service } = makeService(repo, prisma);

      repo.findProjectById.mockResolvedValue(null);

      await expect(service.getTransferTargets('invalid', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
