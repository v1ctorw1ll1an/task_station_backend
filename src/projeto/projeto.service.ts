import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { ProjetoRepository } from './projeto.repository';
import { KanbanGateway } from './kanban.gateway';
import { NotificacaoService } from '../notificacao/notificacao.service';
import { NotificationType } from '../generated/prisma/client';
import { CreateColunaDto } from './dto/create-coluna.dto';
import { UpdateColunaDto } from './dto/update-coluna.dto';
import { ReorderColunasDto } from './dto/reorder-colunas.dto';
import { DeleteColunaDto } from './dto/delete-coluna.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';
import { AssignTaskDto } from './dto/assign-task.dto';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CreateChecklistDto } from './dto/create-checklist.dto';
import { UpdateChecklistDto } from './dto/update-checklist.dto';
import { ReorderChecklistDto } from './dto/reorder-checklist.dto';
import { TransferTaskDto } from './dto/transfer-task.dto';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class ProjetoService {
  constructor(
    private readonly repo: ProjetoRepository,
    private readonly kanbanGateway: KanbanGateway,
    private readonly notificacaoService: NotificacaoService,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(ProjetoService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Kanban ────────────────────────────────────────────────────────────────────

  async getKanban(projectId: string, opts: { tasksPerColumn?: number } = {}) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const kanban = await this.repo.getKanban(projectId, opts);
    this.logger.debug({ projectId, tasksPerColumn: opts.tasksPerColumn }, 'Kanban fetched');
    return kanban;
  }

  async listColumnTasks(
    projectId: string,
    columnId: string,
    opts: { page: number; limit: number },
  ) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }
    const column = await this.repo.findColumnById(columnId, projectId);
    if (!column) {
      throw new NotFoundException('Coluna não encontrada');
    }
    return this.repo.findColumnTasks(columnId, projectId, opts);
  }

  async getProjectLastModifiedAt(projectId: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }
    const lastModifiedAt = await this.repo.getProjectLastModifiedAt(projectId);
    return { lastModifiedAt: lastModifiedAt.toISOString() };
  }

  // ── Colunas ───────────────────────────────────────────────────────────────────

  async createColuna(projectId: string, dto: CreateColunaDto, performedById: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const columns = await this.repo.findColumnsByProject(projectId);
    const lastOrder = columns[columns.length - 1]?.order ?? 0;
    const newOrder = lastOrder + 1000;

    const coluna = await this.repo.createColuna({
      projectId,
      name: dto.name,
      order: newOrder,
      color: dto.color,
    });

    this.logger.info({ projectId, columnId: coluna.id, performedById }, 'Column created');
    this.kanbanGateway.emitToProject(projectId, 'column:created', {
      column: { ...coluna, tasks: [] },
    });
    return coluna;
  }

  async updateColuna(
    projectId: string,
    columnId: string,
    dto: UpdateColunaDto,
    performedById: string,
  ) {
    const column = await this.repo.findColumnById(columnId, projectId);
    if (!column) {
      throw new NotFoundException('Coluna não encontrada');
    }

    const updated = await this.repo.updateColuna(columnId, dto as Prisma.ColumnUpdateInput);
    this.logger.info({ projectId, columnId, changes: dto, performedById }, 'Column updated');
    this.kanbanGateway.emitToProject(projectId, 'column:updated', {
      columnId,
      changes: dto,
    });
    return updated;
  }

  async reorderColunas(projectId: string, dto: ReorderColunasDto, performedById: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    await this.repo.reorderColunas(projectId, dto.columnIds);
    this.logger.info({ projectId, columnIds: dto.columnIds, performedById }, 'Columns reordered');
    this.kanbanGateway.emitToProject(projectId, 'column:reordered', {
      orderedColumnIds: dto.columnIds,
    });

    return this.repo.findColumnsByProject(projectId);
  }

  async deleteColuna(
    projectId: string,
    columnId: string,
    dto: DeleteColunaDto,
    performedById: string,
  ) {
    const column = await this.repo.findColumnById(columnId, projectId);
    if (!column) {
      throw new NotFoundException('Coluna não encontrada');
    }

    const taskCount = await this.repo.countActiveTasksInColumn(columnId);

    if (taskCount > 0 && !dto.targetColumnId) {
      throw new BadRequestException(
        'Esta coluna possui tasks. Informe uma coluna de destino para as tasks existentes.',
      );
    }

    if (dto.targetColumnId) {
      const targetColumn = await this.repo.findColumnById(dto.targetColumnId, projectId);
      if (!targetColumn) {
        throw new NotFoundException('Coluna de destino não encontrada');
      }

      if (dto.targetColumnId === columnId) {
        throw new BadRequestException('A coluna de destino não pode ser a mesma coluna');
      }
    }

    // Captura IDs das tasks antes da migração para incluir no evento
    const tasksBeforeDeletion = dto.targetColumnId
      ? await this.repo.findTasksByColumn(columnId)
      : [];
    const movedTaskIds = tasksBeforeDeletion.map((t) => t.id);

    await this.repo.softDeleteColunaWithMigration(columnId, projectId, dto.targetColumnId);
    this.logger.info(
      { projectId, columnId, targetColumnId: dto.targetColumnId, performedById },
      'Column soft-deleted',
    );
    this.kanbanGateway.emitToProject(projectId, 'column:deleted', {
      columnId,
      targetColumnId: dto.targetColumnId ?? null,
      movedTaskIds,
    });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────────

  async createTask(projectId: string, dto: CreateTaskDto, userId: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const column = await this.repo.findColumnById(dto.columnId, projectId);
    if (!column) {
      throw new NotFoundException('Coluna não encontrada');
    }

    const assigneeIds = [...new Set([userId, ...(dto.assigneeIds ?? [])])];

    const task = await this.repo.createTask({
      projectId,
      columnId: dto.columnId,
      title: dto.title,
      description: dto.description,
      priority: dto.priority,
      assigneeIds,
      reporterId: userId,
      createdById: userId,
      startDate: dto.startDate,
      dueDate: dto.dueDate,
      labelIds: dto.labelIds,
    });

    this.logger.info({ projectId, taskId: task.id, createdById: userId }, 'Task created');
    this.kanbanGateway.emitToProject(projectId, 'task:created', {
      task,
      columnId: dto.columnId,
    });

    // Notify new assignees (non-blocking)
    for (const assigneeId of (task.taskAssignees ?? []).map((a) => a.user.id)) {
      if (assigneeId !== userId) {
        this.notificacaoService
          .notify({
            type: NotificationType.TASK_ASSIGNED,
            recipientId: assigneeId,
            actorId: userId,
            taskId: task.id,
            projectId,
            title: 'Você foi atribuído a uma task',
            body: task.title ?? 'Nova task',
          })
          .catch(() => {
            /* non-blocking */
          });
      }
    }

    return task;
  }

  async updateTask(projectId: string, taskId: string, dto: UpdateTaskDto, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    // Optimistic locking: rejeita se o cliente tem uma versão desatualizada
    if (dto.lastKnownUpdatedAt) {
      const clientTs = new Date(dto.lastKnownUpdatedAt).getTime();
      const serverTs = task.updatedAt.getTime();
      if (Math.abs(clientTs - serverTs) > 0 && clientTs < serverTs) {
        throw new ConflictException(
          'Esta task foi modificada por outro usuário. Recarregue para ver as alterações mais recentes.',
        );
      }
    }

    const updateData: Prisma.TaskUpdateInput = {};

    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.priority !== undefined) updateData.priority = dto.priority;
    if (dto.startDate !== undefined)
      updateData.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.dueDate !== undefined) updateData.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;

    await this.repo.updateTask(taskId, updateData);

    if (dto.labelIds !== undefined) {
      await this.repo.updateTaskLabels(taskId, dto.labelIds);
    }

    if (dto.assigneeIds !== undefined) {
      await this.repo.updateTaskAssignees(taskId, dto.assigneeIds);
    }

    const finalTask = await this.repo.findTaskById(taskId, projectId);

    // Record history
    const fmt = (d: Date | null | undefined): string | null =>
      d ? d.toISOString().split('T')[0] : null;

    const entries: { field: string; oldValue: string | null; newValue: string | null }[] = [];

    if (task.title !== finalTask!.title)
      entries.push({ field: 'title', oldValue: task.title, newValue: finalTask!.title });

    if ((task.description ?? null) !== (finalTask!.description ?? null))
      entries.push({
        field: 'description',
        oldValue: task.description ?? null,
        newValue: finalTask!.description ?? null,
      });

    if (task.priority !== finalTask!.priority)
      entries.push({ field: 'priority', oldValue: task.priority, newValue: finalTask!.priority });

    if (fmt(task.startDate) !== fmt(finalTask!.startDate))
      entries.push({
        field: 'startDate',
        oldValue: fmt(task.startDate),
        newValue: fmt(finalTask!.startDate),
      });

    if (fmt(task.dueDate) !== fmt(finalTask!.dueDate))
      entries.push({
        field: 'dueDate',
        oldValue: fmt(task.dueDate),
        newValue: fmt(finalTask!.dueDate),
      });

    const oldAssignees =
      task.taskAssignees
        .map((a) => a.user.name)
        .sort()
        .join(', ') || null;
    const newAssignees =
      finalTask!.taskAssignees
        .map((a) => a.user.name)
        .sort()
        .join(', ') || null;
    if (oldAssignees !== newAssignees)
      entries.push({ field: 'assignees', oldValue: oldAssignees, newValue: newAssignees });

    const oldLabels =
      task.taskLabels
        .map((l) => l.label.name)
        .sort()
        .join(', ') || null;
    const newLabels =
      finalTask!.taskLabels
        .map((l) => l.label.name)
        .sort()
        .join(', ') || null;
    if (oldLabels !== newLabels)
      entries.push({ field: 'labels', oldValue: oldLabels, newValue: newLabels });

    await this.repo.createTaskHistories(
      entries.map((e) => ({ ...e, taskId, userId: performedById })),
    );

    this.logger.info({ projectId, taskId, changes: dto, performedById }, 'Task updated');
    this.kanbanGateway.emitToProject(projectId, 'task:updated', {
      task: finalTask,
      actorId: performedById,
    });

    // Notify new assignees (TASK_ASSIGNED)
    const oldAssigneeIds = new Set(task.taskAssignees.map((a) => a.user.id));
    const newAssigneeIds = finalTask!.taskAssignees.map((a) => a.user.id);
    for (const assigneeId of newAssigneeIds) {
      if (!oldAssigneeIds.has(assigneeId) && assigneeId !== performedById) {
        this.notificacaoService
          .notify({
            type: NotificationType.TASK_ASSIGNED,
            recipientId: assigneeId,
            actorId: performedById,
            taskId,
            projectId,
            title: 'Você foi atribuído a uma task',
            body: finalTask!.title ?? 'Task atualizada',
          })
          .catch(() => {
            /* non-blocking */
          });
      }
    }

    // Notify TASK_UPDATED for important field changes
    const importantFieldChanged =
      task.title !== finalTask!.title ||
      task.priority !== finalTask!.priority ||
      (task.dueDate?.toISOString() ?? null) !== (finalTask!.dueDate?.toISOString() ?? null);

    if (importantFieldChanged) {
      const allParticipants = new Set([
        ...finalTask!.taskAssignees.map((a) => a.user.id),
        finalTask!.reporter.id,
      ]);
      for (const participantId of allParticipants) {
        if (participantId !== performedById) {
          this.notificacaoService
            .notify({
              type: NotificationType.TASK_UPDATED,
              recipientId: participantId,
              actorId: performedById,
              taskId,
              projectId,
              title: 'Task atualizada',
              body: finalTask!.title ?? 'Uma task que você participa foi atualizada',
            })
            .catch(() => {
              /* non-blocking */
            });
        }
      }
    }

    return finalTask;
  }

  async moveTask(projectId: string, taskId: string, dto: MoveTaskDto, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    const targetColumn = await this.repo.findColumnById(dto.columnId, projectId);
    if (!targetColumn) {
      throw new NotFoundException('Coluna de destino não encontrada');
    }

    const isColumnChange = task.columnId !== dto.columnId;
    let sourceColumnName: string | null = null;
    if (isColumnChange) {
      const sourceColumn = await this.repo.findColumnById(task.columnId, projectId);
      sourceColumnName = sourceColumn?.name ?? null;
    }

    await this.repo.moveTask(taskId, dto.columnId, dto.afterTaskId);

    if (isColumnChange) {
      await this.repo.createTaskHistories([
        {
          taskId,
          userId: performedById,
          field: 'column',
          oldValue: sourceColumnName,
          newValue: targetColumn.name,
        },
      ]);
    }

    this.logger.info(
      { projectId, taskId, columnId: dto.columnId, afterTaskId: dto.afterTaskId, performedById },
      'Task moved',
    );
    this.kanbanGateway.emitToProject(projectId, 'task:moved', {
      taskId,
      fromColumnId: task.columnId,
      toColumnId: dto.columnId,
      afterTaskId: dto.afterTaskId ?? null,
      actorId: performedById,
    });

    return this.repo.findTaskById(taskId, projectId);
  }

  async getTask(projectId: string, taskId: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');
    return task;
  }

  async getTaskHistory(projectId: string, taskId: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }
    return this.repo.getTaskHistory(taskId);
  }

  async deleteTask(projectId: string, taskId: string, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    await this.repo.softDeleteTask(taskId);
    this.logger.info({ projectId, taskId, performedById }, 'Task soft-deleted');
    this.kanbanGateway.emitToProject(projectId, 'task:deleted', {
      taskId,
      columnId: task.columnId,
      actorId: performedById,
    });
  }

  async getDeletedTasks(projectId: string) {
    return this.repo.findDeletedTasks(projectId);
  }

  async restoreTask(projectId: string, taskId: string, performedById: string) {
    const deleted = await this.repo.findDeletedTaskById(taskId, projectId);
    if (!deleted) {
      throw new NotFoundException('Task não encontrada na lixeira');
    }

    const restored = await this.repo.restoreTask(taskId);
    this.logger.info({ projectId, taskId, performedById }, 'Task restored');
    this.kanbanGateway.emitToProject(projectId, 'task:restored', {
      task: restored,
      columnId: restored.columnId,
    });
    return restored;
  }

  async assignTask(projectId: string, taskId: string, dto: AssignTaskDto, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    const userIds = dto.assigneeId ? [dto.assigneeId] : [];
    await this.repo.updateTaskAssignees(taskId, userIds);
    this.logger.info(
      { projectId, taskId, assigneeId: dto.assigneeId, performedById },
      'Task assigned',
    );
    return this.repo.findTaskById(taskId, projectId);
  }

  // ── Membros ───────────────────────────────────────────────────────────────────

  async listMembers(projectId: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    return this.repo.findWorkspaceMembersByProject(projectId);
  }

  // ── Labels ────────────────────────────────────────────────────────────────────

  async listLabels(projectId: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return this.repo.findLabelsByProject(projectId);
  }

  async createLabel(projectId: string, dto: CreateLabelDto, performedById: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) throw new NotFoundException('Projeto não encontrado');

    try {
      const label = await this.repo.createLabel({
        projectId,
        name: dto.name,
        color: dto.color ?? '#6366f1',
      });
      this.logger.info({ projectId, labelId: label.id, performedById }, 'Label created');
      return label;
    } catch {
      throw new ConflictException('Já existe uma label com este nome neste projeto');
    }
  }

  async updateLabel(
    projectId: string,
    labelId: string,
    dto: UpdateLabelDto,
    performedById: string,
  ) {
    const label = await this.repo.findLabelById(labelId, projectId);
    if (!label) throw new NotFoundException('Label não encontrada');

    const updated = await this.repo.updateLabel(labelId, dto);
    this.logger.info({ projectId, labelId, changes: dto, performedById }, 'Label updated');
    return updated;
  }

  async deleteLabel(projectId: string, labelId: string, performedById: string) {
    const label = await this.repo.findLabelById(labelId, projectId);
    if (!label) throw new NotFoundException('Label não encontrada');

    await this.repo.softDeleteLabel(labelId);
    this.logger.info({ projectId, labelId, performedById }, 'Label soft-deleted');
  }

  // ── Checklists ────────────────────────────────────────────────────────────────

  async listChecklists(projectId: string, taskId: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');
    return this.repo.findChecklistsByTask(taskId);
  }

  async createChecklist(
    projectId: string,
    taskId: string,
    dto: CreateChecklistDto,
    userId: string,
  ) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');

    const count = await this.repo.countChecklistsByTask(taskId);
    const item = await this.repo.createChecklist(taskId, userId, dto.title, count + 1);
    this.logger.info({ projectId, taskId, checklistId: item.id, userId }, 'Checklist item created');
    return item;
  }

  async updateChecklist(
    projectId: string,
    taskId: string,
    checklistId: string,
    dto: UpdateChecklistDto,
  ) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');

    const item = await this.repo.findChecklistById(checklistId, taskId);
    if (!item) throw new NotFoundException('Item não encontrado');

    const updated = await this.repo.updateChecklist(checklistId, dto);
    this.logger.info({ projectId, taskId, checklistId }, 'Checklist item updated');
    return updated;
  }

  async deleteChecklist(projectId: string, taskId: string, checklistId: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');

    const item = await this.repo.findChecklistById(checklistId, taskId);
    if (!item) throw new NotFoundException('Item não encontrado');

    await this.repo.softDeleteChecklist(checklistId);
    this.logger.info({ projectId, taskId, checklistId }, 'Checklist item soft-deleted');
  }

  async reorderChecklists(projectId: string, taskId: string, dto: ReorderChecklistDto) {
    const items = dto.items;
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');
    await this.repo.reorderChecklists(items);
    this.logger.info({ projectId, taskId }, 'Checklist reordered');
  }

  // ── Comentários ───────────────────────────────────────────────────────────────

  async listComments(projectId: string, taskId: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');
    return this.repo.findCommentsByTask(taskId);
  }

  async createComment(projectId: string, taskId: string, dto: CreateCommentDto, userId: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');

    const comment = await this.repo.createComment(taskId, userId, dto.content);
    this.logger.info({ projectId, taskId, commentId: comment.id, userId }, 'Comment created');

    // Notify asynchronously (non-blocking)
    void (async () => {
      try {
        // Parse @mentions from comment content
        const mentionMatches = [...dto.content.matchAll(/@(\w+)/g)].map((m) => m[1]);
        const mentionedUserIds = new Set<string>();

        if (mentionMatches.length > 0) {
          const members = await this.repo.findWorkspaceMembersByProject(projectId);
          for (const match of mentionMatches) {
            const matched = members.find(
              (m) => m.name.toLowerCase().split(/\s+/)[0] === match.toLowerCase(),
            );
            if (matched && matched.id !== userId) {
              mentionedUserIds.add(matched.id);
            }
          }
          // Send MENTION notifications
          for (const recipientId of mentionedUserIds) {
            await this.notificacaoService
              .notify({
                type: NotificationType.MENTION,
                recipientId,
                actorId: userId,
                taskId,
                projectId,
                title: 'Você foi mencionado em um comentário',
                body: dto.content.slice(0, 100),
              })
              .catch(() => {
                /* non-blocking */
              });
          }
        }

        // Send TASK_COMMENT to assignees + reporter (excluding commenter and mentioned)
        const participants = new Set([
          ...task.taskAssignees.map((a) => a.user.id),
          task.reporter.id,
        ]);
        for (const participantId of participants) {
          if (participantId !== userId && !mentionedUserIds.has(participantId)) {
            await this.notificacaoService
              .notify({
                type: NotificationType.TASK_COMMENT,
                recipientId: participantId,
                actorId: userId,
                taskId,
                projectId,
                title: 'Novo comentário na task',
                body: dto.content.slice(0, 100),
              })
              .catch(() => {
                /* non-blocking */
              });
          }
        }
      } catch {
        // Notification errors should not affect the main flow
      }
    })();

    return comment;
  }

  async updateComment(
    projectId: string,
    taskId: string,
    commentId: string,
    dto: UpdateCommentDto,
    userId: string,
    isAdmin: boolean,
  ) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');

    const comment = await this.repo.findCommentById(commentId, taskId);
    if (!comment) throw new NotFoundException('Comentário não encontrado');

    if (comment.userId !== userId && !isAdmin) {
      throw new ForbiddenException('Você não tem permissão para editar este comentário');
    }

    const updated = await this.repo.updateComment(commentId, dto.content);
    this.logger.info({ projectId, taskId, commentId, userId }, 'Comment updated');
    return updated;
  }

  async deleteComment(
    projectId: string,
    taskId: string,
    commentId: string,
    userId: string,
    isAdmin: boolean,
  ) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) throw new NotFoundException('Task não encontrada');

    const comment = await this.repo.findCommentById(commentId, taskId);
    if (!comment) throw new NotFoundException('Comentário não encontrado');

    if (comment.userId !== userId && !isAdmin) {
      throw new ForbiddenException('Você não tem permissão para excluir este comentário');
    }

    await this.repo.softDeleteComment(commentId);
    this.logger.info({ projectId, taskId, commentId, userId }, 'Comment soft-deleted');
  }

  // ── Transfer (Copy/Cut) ──────────────────────────────────────────────────────

  async transferTask(
    sourceProjectId: string,
    taskId: string,
    dto: TransferTaskDto,
    performedById: string,
  ) {
    // 1. Validate source task
    const sourceTask = await this.repo.findTaskWithFullRelations(taskId, sourceProjectId, {
      comments: dto.includeComments ?? false,
      attachments: dto.includeAttachments ?? false,
      history: dto.mode === 'cut' && (dto.includeHistory ?? false),
    });
    if (!sourceTask) {
      throw new NotFoundException('Task não encontrada');
    }

    // 2. Validate target project
    const targetProject = await this.repo.findProjectWithWorkspaceInfo(dto.targetProjectId);
    if (!targetProject) {
      throw new NotFoundException('Projeto de destino não encontrado');
    }

    if (dto.targetProjectId === sourceProjectId) {
      throw new BadRequestException('O projeto de destino deve ser diferente do projeto de origem');
    }

    // 3. Validate user access to target project (replicates ProjetoMemberGuard logic)
    await this.validateTargetProjectAccess(performedById, dto.targetProjectId, targetProject);

    // 4. Validate target column belongs to target project
    const targetColumn = await this.repo.findColumnById(dto.targetColumnId, dto.targetProjectId);
    if (!targetColumn) {
      throw new NotFoundException('Coluna de destino não encontrada no projeto de destino');
    }

    // 5. Resolve assignees
    const validAssigneeIds: string[] = [];
    const skippedAssigneeNames: string[] = [];
    if (dto.includeAssignees && sourceTask.taskAssignees.length > 0) {
      const targetMembers = await this.repo.findWorkspaceMembersByProject(dto.targetProjectId);
      const targetMemberIds = new Set(targetMembers.map((m) => m.id));

      for (const assignee of sourceTask.taskAssignees) {
        if (targetMemberIds.has(assignee.user.id)) {
          validAssigneeIds.push(assignee.user.id);
        } else {
          skippedAssigneeNames.push(assignee.user.name);
        }
      }
    }

    // 6. Resolve labels
    const resolvedLabelIds: string[] = [];
    const labelMode = dto.includeLabels ?? 'skip';
    if (labelMode !== 'skip' && sourceTask.taskLabels.length > 0) {
      const sourceLabels = sourceTask.taskLabels.map((tl) => tl.label);
      const matchingLabels = await this.repo.findMatchingLabelsByName(
        dto.targetProjectId,
        sourceLabels.map((l) => l.name),
      );
      const matchMap = new Map<string, string>(
        matchingLabels.map((l): [string, string] => [l.name, l.id]),
      );

      for (const label of sourceLabels) {
        if (matchMap.has(label.name)) {
          resolvedLabelIds.push(matchMap.get(label.name)!);
        } else if (labelMode === 'create') {
          try {
            const created = await this.repo.createLabel({
              projectId: dto.targetProjectId,
              name: label.name,
              color: label.color,
            });
            resolvedLabelIds.push(created.id);
          } catch {
            // Unique constraint race condition — try to find it again
            const retry = await this.repo.findMatchingLabelsByName(dto.targetProjectId, [
              label.name,
            ]);
            if (retry.length > 0) {
              resolvedLabelIds.push(retry[0].id);
            }
          }
        }
      }
    }

    // 7. Prepare comments
    const comments =
      dto.includeComments && 'taskComments' in sourceTask
        ? ((sourceTask as Record<string, unknown>).taskComments as {
            userId: string;
            content: string;
            createdAt: Date;
          }[])
        : [];

    // 8. Prepare history entries (only for cut + includeHistory)
    const historyEntries =
      dto.mode === 'cut' && dto.includeHistory && 'taskHistory' in sourceTask
        ? ((sourceTask as Record<string, unknown>).taskHistory as {
            userId: string;
            field: string;
            oldValue: string | null;
            newValue: string | null;
            changedAt: Date;
          }[])
        : [];

    // 9. Prepare attachments
    const attachments =
      dto.includeAttachments && 'taskAttachments' in sourceTask
        ? ((sourceTask as Record<string, unknown>).taskAttachments as {
            uploadedById: string;
            originalName: string;
            storedName: string;
            mimeType: string;
            size: number;
            hasThumbnail: boolean;
          }[])
        : [];

    // 10. Determine dates
    const includeDates = dto.includeDates ?? true;

    // 11. Get source project name for history entry
    const sourceProject = await this.repo.findProjectWithWorkspaceInfo(sourceProjectId);
    const sourceProjectName = sourceProject?.name ?? sourceProjectId;
    const targetProjectName = targetProject.name;

    // 12. Create the transferred task
    const newTask = await this.repo.createTransferredTask({
      targetProjectId: dto.targetProjectId,
      targetColumnId: dto.targetColumnId,
      title: sourceTask.title,
      description: sourceTask.description,
      priority: sourceTask.priority,
      reporterId: performedById,
      createdById: performedById,
      startDate: includeDates ? sourceTask.startDate : null,
      dueDate: includeDates ? sourceTask.dueDate : null,
      assigneeIds: validAssigneeIds,
      labelIds: resolvedLabelIds,
      comments,
      historyEntries,
      attachments,
      transferHistoryEntry: {
        userId: performedById,
        field: 'transferred_from',
        oldValue: sourceProjectName,
        newValue: targetProjectName,
      },
      softDeleteSourceTaskId: dto.mode === 'cut' ? taskId : null,
    });

    // 13. Handle attachment files (outside transaction — non-critical)
    if (attachments.length > 0) {
      const uploadsBase = path.resolve(process.cwd(), 'uploads', 'attachments');
      const sourceDir = path.join(uploadsBase, taskId);
      const targetDir = path.join(uploadsBase, newTask.id);

      try {
        if (dto.mode === 'cut') {
          await fs.rename(sourceDir, targetDir);
        } else {
          await fs.cp(sourceDir, targetDir, { recursive: true });
        }
      } catch (err) {
        this.logger.warn(
          { sourceTaskId: taskId, newTaskId: newTask.id, error: String(err) },
          'Failed to copy/move attachment files',
        );
      }
    }

    // 14. WebSocket events
    this.kanbanGateway.emitToProject(dto.targetProjectId, 'task:created', {
      task: newTask,
      columnId: dto.targetColumnId,
    });

    if (dto.mode === 'cut') {
      this.kanbanGateway.emitToProject(sourceProjectId, 'task:deleted', {
        taskId,
        columnId: sourceTask.columnId,
        actorId: performedById,
      });

      // Add history to source project for cut
      await this.repo.createTaskHistories([
        {
          taskId,
          userId: performedById,
          field: 'transferred_to',
          oldValue: sourceProjectName,
          newValue: targetProjectName,
        },
      ]);
    }

    // 15. Notifications (non-blocking)
    for (const assigneeId of validAssigneeIds) {
      if (assigneeId !== performedById) {
        this.notificacaoService
          .notify({
            type: NotificationType.TASK_ASSIGNED,
            recipientId: assigneeId,
            actorId: performedById,
            taskId: newTask.id,
            projectId: dto.targetProjectId,
            title: 'Você foi atribuído a uma task',
            body: newTask.title ?? 'Task transferida',
          })
          .catch(() => {
            /* non-blocking */
          });
      }
    }

    this.logger.info(
      {
        sourceProjectId,
        targetProjectId: dto.targetProjectId,
        sourceTaskId: taskId,
        newTaskId: newTask.id,
        mode: dto.mode,
        performedById,
      },
      'Task transferred',
    );

    return {
      task: newTask,
      skippedAssignees: skippedAssigneeNames,
    };
  }

  async getTransferTargets(projectId: string, userId: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const projects = await this.repo.findAccessibleProjects(userId, projectId);

    // Group by workspace
    const grouped: Record<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        projects: { id: string; name: string; columns: { id: string; name: string }[] }[];
      }
    > = {};

    for (const p of projects) {
      if (!grouped[p.workspaceId]) {
        grouped[p.workspaceId] = {
          workspaceId: p.workspaceId,
          workspaceName: p.workspace.name,
          projects: [],
        };
      }
      grouped[p.workspaceId].projects.push({
        id: p.id,
        name: p.name,
        columns: p.columns,
      });
    }

    return Object.values(grouped);
  }

  private async validateTargetProjectAccess(
    userId: string,
    targetProjectId: string,
    targetProject: { workspaceId: string; workspace: { companyId: string } },
  ) {
    const [workspaceMembership, companyAdminMembership] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId,
          resourceType: 'workspace',
          resourceId: targetProject.workspaceId,
          deletedAt: null,
        },
        select: { role: true },
      }),
      this.prisma.membership.findFirst({
        where: {
          userId,
          resourceType: 'company',
          resourceId: targetProject.workspace.companyId,
          role: 'admin',
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    if (!workspaceMembership && !companyAdminMembership) {
      throw new ForbiddenException('Você não tem acesso ao projeto de destino');
    }

    // Company admin bypasses project restrictions
    if (companyAdminMembership) return;

    // Check project restriction for non-admin workspace members
    if (workspaceMembership!.role !== 'workspace_admin') {
      const restriction = await this.prisma.projectRestriction.findUnique({
        where: { userId_projectId: { userId, projectId: targetProjectId } },
      });
      if (restriction) {
        throw new ForbiddenException('Você não tem acesso ao projeto de destino');
      }
    }
  }
}
