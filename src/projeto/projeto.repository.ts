import { Injectable } from '@nestjs/common';
import { Prisma, TaskPriority } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TASK_SELECT = {
  id: true,
  title: true,
  description: true,
  priority: true,
  order: true,
  dueDate: true,
  startDate: true,
  columnId: true,
  projectId: true,
  assignee: { select: { id: true, name: true } },
  reporter: { select: { id: true, name: true } },
} as const;

const COLUMN_SELECT = {
  id: true,
  name: true,
  color: true,
  order: true,
  projectId: true,
} as const;

@Injectable()
export class ProjetoRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Projeto ───────────────────────────────────────────────────────────────────

  findProjectById(projectId: string) {
    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, workspaceId: true, isActive: true },
    });
  }

  // ── Colunas ───────────────────────────────────────────────────────────────────

  findColumnById(columnId: string, projectId: string) {
    return this.prisma.column.findFirst({
      where: { id: columnId, projectId, deletedAt: null },
      select: COLUMN_SELECT,
    });
  }

  findColumnsByProject(projectId: string) {
    return this.prisma.column.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { order: 'asc' },
      select: COLUMN_SELECT,
    });
  }

  countActiveTasksInColumn(columnId: string) {
    return this.prisma.task.count({
      where: { columnId, deletedAt: null },
    });
  }

  createColuna(data: { projectId: string; name: string; order: number; color?: string }) {
    return this.prisma.column.create({ data, select: COLUMN_SELECT });
  }

  updateColuna(columnId: string, data: Prisma.ColumnUpdateInput) {
    return this.prisma.column.update({
      where: { id: columnId },
      data,
      select: COLUMN_SELECT,
    });
  }

  softDeleteColunaWithMigration(
    columnId: string,
    projectId: string,
    targetColumnId: string | undefined,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (targetColumnId) {
        // Buscar tasks ativas da coluna, ordenadas
        const tasks = await tx.task.findMany({
          where: { columnId, deletedAt: null },
          orderBy: { order: 'asc' },
          select: { id: true },
        });

        if (tasks.length > 0) {
          // Buscar maior ordem atual na coluna destino
          const lastTask = await tx.task.findFirst({
            where: { columnId: targetColumnId, deletedAt: null },
            orderBy: { order: 'desc' },
            select: { order: true },
          });

          let nextOrder = (lastTask?.order ?? 0) + 1000;

          for (const task of tasks) {
            await tx.task.update({
              where: { id: task.id },
              data: { columnId: targetColumnId, order: nextOrder },
            });
            nextOrder += 1000;
          }
        }
      }

      return tx.column.update({
        where: { id: columnId },
        data: { deletedAt: new Date() },
        select: COLUMN_SELECT,
      });
    });
  }

  reorderColunas(projectId: string, columnIds: string[]) {
    return this.prisma.$transaction(
      columnIds.map((id, index) =>
        this.prisma.column.update({
          where: { id },
          data: { order: (index + 1) * 1000 },
        }),
      ),
    );
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────────

  findTaskById(taskId: string, projectId: string) {
    return this.prisma.task.findFirst({
      where: { id: taskId, projectId, deletedAt: null },
      select: TASK_SELECT,
    });
  }

  findTasksByColumn(columnId: string) {
    return this.prisma.task.findMany({
      where: { columnId, deletedAt: null },
      orderBy: { order: 'asc' },
      select: TASK_SELECT,
    });
  }

  findAllTasksByProject(projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ columnId: 'asc' }, { order: 'asc' }],
      select: TASK_SELECT,
    });
  }

  async createTask(data: {
    projectId: string;
    columnId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    assigneeId?: string;
    reporterId: string;
    createdById: string;
    startDate?: string;
    dueDate?: string;
  }) {
    // Buscar maior ordem atual na coluna
    const lastTask = await this.prisma.task.findFirst({
      where: { columnId: data.columnId, deletedAt: null },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    const order = (lastTask?.order ?? 0) + 1000;

    return this.prisma.task.create({
      data: {
        projectId: data.projectId,
        columnId: data.columnId,
        title: data.title,
        description: data.description,
        priority: data.priority ?? TaskPriority.medium,
        order,
        reporterId: data.reporterId,
        assigneeId: data.assigneeId,
        createdById: data.createdById,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
      },
      select: TASK_SELECT,
    });
  }

  updateTask(taskId: string, data: Prisma.TaskUpdateInput) {
    return this.prisma.task.update({
      where: { id: taskId },
      data,
      select: TASK_SELECT,
    });
  }

  softDeleteTask(taskId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: new Date() },
    });
  }

  moveTask(taskId: string, columnId: string, afterTaskId: string | null | undefined) {
    return this.prisma.$transaction(async (tx) => {
      // Buscar tasks da coluna destino ordenadas
      const tasksInColumn = await tx.task.findMany({
        where: { columnId, deletedAt: null, id: { not: taskId } },
        orderBy: { order: 'asc' },
        select: { id: true, order: true },
      });

      let newOrder: number;

      if (!afterTaskId) {
        // Inserir no início
        const firstOrder = tasksInColumn[0]?.order ?? 1000;
        newOrder = Math.round(firstOrder / 2);
        if (newOrder < 1) newOrder = 0;
      } else {
        const afterIndex = tasksInColumn.findIndex((t) => t.id === afterTaskId);
        const afterTask = tasksInColumn[afterIndex];
        const nextTask = tasksInColumn[afterIndex + 1];

        if (!afterTask) {
          // afterTaskId não encontrado → inserir no fim
          const lastOrder = tasksInColumn[tasksInColumn.length - 1]?.order ?? 0;
          newOrder = lastOrder + 1000;
        } else if (!nextTask) {
          // Inserir no fim
          newOrder = afterTask.order + 1000;
        } else {
          newOrder = Math.round((afterTask.order + nextTask.order) / 2);
        }
      }

      // Atualizar a task
      await tx.task.update({
        where: { id: taskId },
        data: { columnId, order: newOrder },
      });

      // Verificar necessidade de rebalanceamento
      const allTasks = await tx.task.findMany({
        where: { columnId, deletedAt: null },
        orderBy: { order: 'asc' },
        select: { id: true, order: true },
      });

      let needsRebalance = false;
      for (let i = 1; i < allTasks.length; i++) {
        if (allTasks[i].order - allTasks[i - 1].order < 2) {
          needsRebalance = true;
          break;
        }
      }

      if (needsRebalance) {
        await Promise.all(
          allTasks.map((t, i) =>
            tx.task.update({
              where: { id: t.id },
              data: { order: (i + 1) * 1000 },
            }),
          ),
        );
      }
    });
  }

  // ── Kanban ────────────────────────────────────────────────────────────────────

  async getKanban(projectId: string) {
    const columns = await this.prisma.column.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { order: 'asc' },
      select: {
        ...COLUMN_SELECT,
        tasks: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
          select: TASK_SELECT,
        },
      },
    });

    return { columns };
  }

  // ── Membros do workspace (para select de responsável) ─────────────────────────

  async findWorkspaceMembersByProject(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { workspaceId: true },
    });

    if (!project) return [];

    const memberships = await this.prisma.membership.findMany({
      where: {
        resourceType: 'workspace',
        resourceId: project.workspaceId,
        deletedAt: null,
      },
      select: { userId: true },
    });

    const userIds = memberships.map((m) => m.userId);
    if (userIds.length === 0) return [];

    return this.prisma.user.findMany({
      where: { id: { in: userIds }, deletedAt: null, isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
  }
}
