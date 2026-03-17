import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TaskPriority } from '../generated/prisma/client';
import { ProjetoRepository } from './projeto.repository';
import { ProjetoService } from './projeto.service';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    workspaceId: 'ws-1',
    isActive: true,
    ...overrides,
  };
}

function makeColumn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'col-1',
    name: 'A Fazer',
    color: null,
    order: 1000,
    projectId: 'project-1',
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Minha task',
    description: null,
    priority: TaskPriority.medium,
    order: 1000,
    dueDate: null,
    startDate: null,
    columnId: 'col-1',
    projectId: 'project-1',
    updatedAt: new Date(),
    taskAssignees: [],
    taskLabels: [],
    reporter: { id: 'user-1', name: 'User', email: 'user@test.com', photoUrl: null },
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
    createTaskHistories: jest.fn().mockResolvedValue({ count: 1 }),
    ...overrides,
  } as unknown as jest.Mocked<ProjetoRepository>;
}

function makeService(repo: jest.Mocked<ProjetoRepository>) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const kanbanGateway = { emitToProject: jest.fn() } as never;
  const notificacaoService = { notificar: jest.fn() } as never;
  const service = new ProjetoService(repo, kanbanGateway, notificacaoService, logger as never);
  return service;
}

// ── testes ─────────────────────────────────────────────────────────────────────

describe('ProjetoService', () => {
  describe('getKanban', () => {
    it('retorna kanban com colunas e tasks', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(makeProject());
      repo.getKanban.mockResolvedValue({
        columns: [{ ...makeColumn(), tasks: [makeTask()] }],
      });
      const service = makeService(repo);

      const result = await service.getKanban('project-1');

      expect(result.columns).toHaveLength(1);
      expect(result.columns[0].tasks).toHaveLength(1);
    });

    it('lança NotFoundException se projeto não existe', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(service.getKanban('invalid')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createColuna', () => {
    it('cria coluna com ordem após a última', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(makeProject());
      repo.findColumnsByProject.mockResolvedValue([
        makeColumn({ order: 1000 }),
        makeColumn({ id: 'col-2', order: 2000 }),
      ]);
      const newCol = makeColumn({ id: 'col-3', name: 'Review', order: 3000 });
      repo.createColuna.mockResolvedValue(newCol);
      const service = makeService(repo);

      const result = await service.createColuna('project-1', { name: 'Review' }, 'user-1');

      expect(repo.createColuna).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Review', order: 3000 }),
      );
      expect(result.name).toBe('Review');
    });

    it('lança NotFoundException se projeto não existe', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(service.createColuna('invalid', { name: 'X' }, 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateColuna', () => {
    it('atualiza coluna com sucesso', async () => {
      const repo = makeRepo();
      repo.findColumnById.mockResolvedValue(makeColumn());
      const updated = makeColumn({ name: 'Em Review' });
      repo.updateColuna.mockResolvedValue(updated);
      const service = makeService(repo);

      const result = await service.updateColuna(
        'project-1',
        'col-1',
        { name: 'Em Review' },
        'user-1',
      );

      expect(result.name).toBe('Em Review');
    });

    it('lança NotFoundException se coluna não encontrada', async () => {
      const repo = makeRepo();
      repo.findColumnById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(
        service.updateColuna('project-1', 'invalid', { name: 'X' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteColuna', () => {
    it('deleta coluna sem tasks sem exigir targetColumnId', async () => {
      const repo = makeRepo();
      repo.findColumnById.mockResolvedValue(makeColumn());
      repo.countActiveTasksInColumn.mockResolvedValue(0);
      repo.softDeleteColunaWithMigration.mockResolvedValue(makeColumn());
      const service = makeService(repo);

      await service.deleteColuna('project-1', 'col-1', {}, 'user-1');

      expect(repo.softDeleteColunaWithMigration).toHaveBeenCalledWith(
        'col-1',
        'project-1',
        undefined,
      );
    });

    it('lança BadRequestException se coluna tem tasks e sem targetColumnId', async () => {
      const repo = makeRepo();
      repo.findColumnById.mockResolvedValue(makeColumn());
      repo.countActiveTasksInColumn.mockResolvedValue(3);
      const service = makeService(repo);

      await expect(service.deleteColuna('project-1', 'col-1', {}, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('migra tasks para targetColumnId antes de deletar', async () => {
      const repo = makeRepo();
      repo.findColumnById
        .mockResolvedValueOnce(makeColumn({ id: 'col-1' }))
        .mockResolvedValueOnce(makeColumn({ id: 'col-2' }));
      repo.countActiveTasksInColumn.mockResolvedValue(2);
      repo.findTasksByColumn.mockResolvedValue([makeTask()]);
      repo.softDeleteColunaWithMigration.mockResolvedValue(makeColumn());
      const service = makeService(repo);

      await service.deleteColuna('project-1', 'col-1', { targetColumnId: 'col-2' }, 'user-1');

      expect(repo.softDeleteColunaWithMigration).toHaveBeenCalledWith(
        'col-1',
        'project-1',
        'col-2',
      );
    });

    it('lança BadRequestException se targetColumnId == columnId', async () => {
      const repo = makeRepo();
      repo.findColumnById.mockResolvedValue(makeColumn());
      repo.countActiveTasksInColumn.mockResolvedValue(1);
      const service = makeService(repo);

      await expect(
        service.deleteColuna('project-1', 'col-1', { targetColumnId: 'col-1' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createTask', () => {
    it('cria task com sucesso', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(makeProject());
      repo.findColumnById.mockResolvedValue(makeColumn());
      repo.createTask.mockResolvedValue(makeTask());
      const service = makeService(repo);

      const result = await service.createTask(
        'project-1',
        { title: 'Minha task', columnId: 'col-1' },
        'user-1',
      );

      expect(result.title).toBe('Minha task');
      expect(repo.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          columnId: 'col-1',
          title: 'Minha task',
          reporterId: 'user-1',
          createdById: 'user-1',
        }),
      );
    });

    it('lança NotFoundException se projeto não existe', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(
        service.createTask('invalid', { title: 'X', columnId: 'col-1' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lança NotFoundException se coluna não existe', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(makeProject());
      repo.findColumnById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(
        service.createTask('project-1', { title: 'X', columnId: 'invalid' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateTask', () => {
    it('atualiza task com sucesso', async () => {
      const repo = makeRepo();
      const updated = makeTask({ title: 'Atualizada' });
      repo.findTaskById.mockResolvedValueOnce(makeTask()).mockResolvedValueOnce(updated);
      repo.updateTask.mockResolvedValue(updated);
      repo.updateTaskLabels.mockResolvedValue([] as never);
      repo.updateTaskAssignees.mockResolvedValue([{ count: 0 }] as never);
      const service = makeService(repo);

      const result = await service.updateTask(
        'project-1',
        'task-1',
        { title: 'Atualizada' },
        'user-1',
      );

      expect(result?.title).toBe('Atualizada');
    });

    it('lança NotFoundException se task não existe', async () => {
      const repo = makeRepo();
      repo.findTaskById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(service.updateTask('project-1', 'invalid', {}, 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('moveTask', () => {
    it('move task para outra coluna', async () => {
      const repo = makeRepo();
      repo.findTaskById
        .mockResolvedValueOnce(makeTask())
        .mockResolvedValueOnce(makeTask({ columnId: 'col-2' }));
      repo.findColumnById.mockResolvedValue(makeColumn({ id: 'col-2' }));
      repo.moveTask.mockResolvedValue(undefined);
      const service = makeService(repo);

      await service.moveTask('project-1', 'task-1', { columnId: 'col-2' }, 'user-1');

      expect(repo.moveTask).toHaveBeenCalledWith('task-1', 'col-2', undefined);
    });

    it('lança NotFoundException se task não existe', async () => {
      const repo = makeRepo();
      repo.findTaskById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(
        service.moveTask('project-1', 'invalid', { columnId: 'col-1' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lança NotFoundException se coluna destino não existe', async () => {
      const repo = makeRepo();
      repo.findTaskById.mockResolvedValue(makeTask());
      repo.findColumnById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(
        service.moveTask('project-1', 'task-1', { columnId: 'invalid' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteTask', () => {
    it('soft deleta task com sucesso', async () => {
      const repo = makeRepo();
      repo.findTaskById.mockResolvedValue(makeTask());
      repo.softDeleteTask.mockResolvedValue(undefined as never);
      const service = makeService(repo);

      await service.deleteTask('project-1', 'task-1', 'user-1');

      expect(repo.softDeleteTask).toHaveBeenCalledWith('task-1');
    });

    it('lança NotFoundException se task não existe', async () => {
      const repo = makeRepo();
      repo.findTaskById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(service.deleteTask('project-1', 'invalid', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('assignTask', () => {
    it('atribui assignee com sucesso', async () => {
      const repo = makeRepo();
      const taskWithAssignee = makeTask({
        taskAssignees: [{ user: { id: 'user-2', name: 'Ana' } }],
      });
      repo.findTaskById.mockResolvedValueOnce(makeTask()).mockResolvedValueOnce(taskWithAssignee);
      repo.updateTaskAssignees.mockResolvedValue([{ count: 0 }] as never);
      const service = makeService(repo);

      const result = await service.assignTask(
        'project-1',
        'task-1',
        { assigneeId: 'user-2' },
        'user-1',
      );

      expect(repo.updateTaskAssignees).toHaveBeenCalledWith('task-1', ['user-2']);
      expect(result?.taskAssignees[0]?.user).toEqual({ id: 'user-2', name: 'Ana' });
    });

    it('remove assignee quando assigneeId é undefined', async () => {
      const repo = makeRepo();
      repo.findTaskById.mockResolvedValue(makeTask());
      repo.updateTaskAssignees.mockResolvedValue([{ count: 0 }] as never);
      const service = makeService(repo);

      await service.assignTask('project-1', 'task-1', {}, 'user-1');

      expect(repo.updateTaskAssignees).toHaveBeenCalledWith('task-1', []);
    });

    it('lança NotFoundException se task não existe', async () => {
      const repo = makeRepo();
      repo.findTaskById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(service.assignTask('project-1', 'invalid', {}, 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reorderColunas', () => {
    it('reordena colunas com sucesso', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(makeProject());
      repo.reorderColunas.mockResolvedValue([]);
      repo.findColumnsByProject.mockResolvedValue([
        makeColumn({ id: 'col-2', order: 1000 }),
        makeColumn({ id: 'col-1', order: 2000 }),
      ]);
      const service = makeService(repo);

      const result = await service.reorderColunas(
        'project-1',
        { columnIds: ['col-2', 'col-1'] },
        'user-1',
      );

      expect(repo.reorderColunas).toHaveBeenCalledWith('project-1', ['col-2', 'col-1']);
      expect(result).toHaveLength(2);
    });

    it('lança NotFoundException se projeto não existe', async () => {
      const repo = makeRepo();
      repo.findProjectById.mockResolvedValue(null);
      const service = makeService(repo);

      await expect(service.reorderColunas('invalid', { columnIds: [] }, 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
