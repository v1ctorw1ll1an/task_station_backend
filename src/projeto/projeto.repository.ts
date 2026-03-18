import { Injectable } from '@nestjs/common';
import { Prisma, TaskPriority } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TASK_SELECT = {
  id: true,
  taskNumber: true,
  title: true,
  description: true,
  priority: true,
  order: true,
  dueDate: true,
  startDate: true,
  updatedAt: true,
  columnId: true,
  projectId: true,
  taskAssignees: {
    select: { user: { select: { id: true, name: true, email: true, photoUrl: true } } },
  },
  reporter: { select: { id: true, name: true, email: true, photoUrl: true } },
  taskLabels: {
    where: { label: { deletedAt: null } },
    select: { label: { select: { id: true, name: true, color: true } } },
  },
  _count: { select: { taskComments: true } },
} as const;

const LABEL_SELECT = {
  id: true,
  name: true,
  color: true,
  projectId: true,
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
    assigneeIds?: string[];
    reporterId: string;
    createdById: string;
    startDate?: string;
    dueDate?: string;
    labelIds?: string[];
  }) {
    return this.prisma.$transaction(async (tx) => {
      // Incrementa o contador do projeto atomicamente e obtém o novo valor
      const updatedProject = await tx.project.update({
        where: { id: data.projectId },
        data: { taskCounter: { increment: 1 } },
        select: { taskCounter: true },
      });

      const taskNumber = updatedProject.taskCounter;

      // Buscar maior ordem atual na coluna
      const lastTask = await tx.task.findFirst({
        where: { columnId: data.columnId, deletedAt: null },
        orderBy: { order: 'desc' },
        select: { order: true },
      });

      const order = (lastTask?.order ?? 0) + 1000;

      return tx.task.create({
        data: {
          projectId: data.projectId,
          columnId: data.columnId,
          taskNumber,
          title: data.title,
          description: data.description,
          priority: data.priority ?? TaskPriority.medium,
          order,
          reporterId: data.reporterId,
          createdById: data.createdById,
          startDate: data.startDate ? new Date(data.startDate) : undefined,
          dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
          ...(data.labelIds?.length
            ? { taskLabels: { create: data.labelIds.map((labelId) => ({ labelId })) } }
            : {}),
          ...(data.assigneeIds?.length
            ? { taskAssignees: { create: data.assigneeIds.map((userId) => ({ userId })) } }
            : {}),
        },
        select: TASK_SELECT,
      });
    });
  }

  async updateTaskAssignees(taskId: string, userIds: string[]) {
    return this.prisma.$transaction([
      this.prisma.taskAssignee.deleteMany({ where: { taskId } }),
      ...userIds.map((userId) => this.prisma.taskAssignee.create({ data: { taskId, userId } })),
    ]);
  }

  updateTask(taskId: string, data: Prisma.TaskUpdateInput) {
    return this.prisma.task.update({
      where: { id: taskId },
      data,
      select: TASK_SELECT,
    });
  }

  async updateTaskLabels(taskId: string, labelIds: string[]) {
    return this.prisma.$transaction([
      this.prisma.taskLabel.deleteMany({ where: { taskId } }),
      ...labelIds.map((labelId) => this.prisma.taskLabel.create({ data: { taskId, labelId } })),
    ]);
  }

  softDeleteTask(taskId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: new Date() },
    });
  }

  findDeletedTaskById(taskId: string, projectId: string) {
    return this.prisma.task.findFirst({
      where: { id: taskId, projectId, deletedAt: { not: null } },
      select: { id: true },
    });
  }

  findDeletedTasks(projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId, deletedAt: { not: null } },
      select: {
        ...TASK_SELECT,
        deletedAt: true,
        column: { select: { id: true, name: true } },
      },
      orderBy: { deletedAt: 'desc' },
    });
  }

  restoreTask(taskId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: null },
      select: TASK_SELECT,
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

  async getProjectLastModifiedAt(projectId: string): Promise<Date> {
    const result = await this.prisma.$queryRaw<[{ last_modified: Date }]>`
      SELECT GREATEST(
        COALESCE((
          SELECT MAX(t.updated_at)
          FROM tasks t
          JOIN columns c ON c.id = t.column_id
          WHERE c.project_id = ${projectId}
            AND t.deleted_at IS NULL
            AND c.deleted_at IS NULL
        ), '1970-01-01'::timestamptz),
        COALESCE((
          SELECT MAX(updated_at)
          FROM columns
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
        ), '1970-01-01'::timestamptz)
      ) AS last_modified
    `;
    return result[0].last_modified;
  }

  async getKanban(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true },
    });

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

    return { columns, projectName: project?.name ?? '' };
  }

  // ── Membros do workspace (para select de responsável) ─────────────────────────

  async findWorkspaceMembersByProject(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        workspaceId: true,
        workspace: { select: { companyId: true } },
      },
    });

    if (!project) return [];

    const [workspaceMemberships, companyAdminMemberships] = await Promise.all([
      this.prisma.membership.findMany({
        where: { resourceType: 'workspace', resourceId: project.workspaceId, deletedAt: null },
        select: { userId: true },
      }),
      this.prisma.membership.findMany({
        where: {
          resourceType: 'company',
          resourceId: project.workspace.companyId,
          role: 'admin',
          deletedAt: null,
        },
        select: { userId: true },
      }),
    ]);

    const userIds = [
      ...new Set([
        ...workspaceMemberships.map((m) => m.userId),
        ...companyAdminMemberships.map((m) => m.userId),
      ]),
    ];

    if (userIds.length === 0) return [];

    return this.prisma.user.findMany({
      where: { id: { in: userIds }, deletedAt: null, isActive: true },
      select: { id: true, name: true, email: true, photoUrl: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── Labels ────────────────────────────────────────────────────────────────────

  findLabelsByProject(projectId: string) {
    return this.prisma.label.findMany({
      where: { projectId, deletedAt: null },
      select: LABEL_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  findLabelById(labelId: string, projectId: string) {
    return this.prisma.label.findFirst({
      where: { id: labelId, projectId, deletedAt: null },
      select: LABEL_SELECT,
    });
  }

  createLabel(data: { projectId: string; name: string; color: string }) {
    return this.prisma.label.create({ data, select: LABEL_SELECT });
  }

  updateLabel(labelId: string, data: { name?: string; color?: string }) {
    return this.prisma.label.update({
      where: { id: labelId },
      data,
      select: LABEL_SELECT,
    });
  }

  softDeleteLabel(labelId: string) {
    return this.prisma.label.update({
      where: { id: labelId },
      data: { deletedAt: new Date() },
      select: LABEL_SELECT,
    });
  }

  // ── Task Comments ─────────────────────────────────────────────────────────────

  findCommentsByTask(taskId: string) {
    return this.prisma.taskComment.findMany({
      where: { taskId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });
  }

  findCommentById(commentId: string, taskId: string) {
    return this.prisma.taskComment.findFirst({
      where: { id: commentId, taskId, deletedAt: null },
      select: { id: true, taskId: true, userId: true, content: true },
    });
  }

  createComment(taskId: string, userId: string, content: string) {
    return this.prisma.taskComment.create({
      data: { taskId, userId, content },
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });
  }

  updateComment(commentId: string, content: string) {
    return this.prisma.taskComment.update({
      where: { id: commentId },
      data: { content },
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });
  }

  softDeleteComment(commentId: string) {
    return this.prisma.taskComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });
  }

  // ── Task History ──────────────────────────────────────────────────────────────

  createTaskHistories(
    entries: {
      taskId: string;
      userId: string;
      field: string;
      oldValue: string | null;
      newValue: string | null;
    }[],
  ) {
    if (entries.length === 0) return Promise.resolve({ count: 0 });
    return this.prisma.taskHistory.createMany({ data: entries });
  }

  getTaskHistory(taskId: string) {
    return this.prisma.taskHistory.findMany({
      where: { taskId },
      orderBy: { changedAt: 'desc' },
      select: {
        id: true,
        field: true,
        oldValue: true,
        newValue: true,
        changedAt: true,
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  createAttachment(data: {
    taskId: string;
    uploadedById: string;
    originalName: string;
    storedName: string;
    mimeType: string;
    size: number;
    hasThumbnail: boolean;
  }) {
    return this.prisma.taskAttachment.create({
      data,
      select: {
        id: true,
        taskId: true,
        originalName: true,
        storedName: true,
        mimeType: true,
        size: true,
        hasThumbnail: true,
        createdAt: true,
        uploadedBy: { select: { id: true, name: true } },
      },
    });
  }

  findAttachments(taskId: string) {
    return this.prisma.taskAttachment.findMany({
      where: { taskId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        taskId: true,
        originalName: true,
        storedName: true,
        mimeType: true,
        size: true,
        hasThumbnail: true,
        createdAt: true,
        uploadedBy: { select: { id: true, name: true } },
      },
    });
  }

  findAttachmentById(id: string, taskId: string) {
    return this.prisma.taskAttachment.findFirst({
      where: { id, taskId, deletedAt: null },
      select: {
        id: true,
        originalName: true,
        storedName: true,
        mimeType: true,
        hasThumbnail: true,
      },
    });
  }

  softDeleteAttachment(id: string) {
    return this.prisma.taskAttachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  countAttachments(taskId: string, mimePrefix: 'image/' | 'video/') {
    return this.prisma.taskAttachment.count({
      where: { taskId, deletedAt: null, mimeType: { startsWith: mimePrefix } },
    });
  }
}
