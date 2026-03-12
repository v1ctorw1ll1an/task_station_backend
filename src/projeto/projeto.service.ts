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

@Injectable()
export class ProjetoService {
  constructor(
    private readonly repo: ProjetoRepository,
    @InjectPinoLogger(ProjetoService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Kanban ────────────────────────────────────────────────────────────────────

  async getKanban(projectId: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const kanban = await this.repo.getKanban(projectId);
    this.logger.debug({ projectId }, 'Kanban fetched');
    return kanban;
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
    return updated;
  }

  async reorderColunas(projectId: string, dto: ReorderColunasDto, performedById: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    await this.repo.reorderColunas(projectId, dto.columnIds);
    this.logger.info({ projectId, columnIds: dto.columnIds, performedById }, 'Columns reordered');

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

    await this.repo.softDeleteColunaWithMigration(columnId, projectId, dto.targetColumnId);
    this.logger.info(
      { projectId, columnId, targetColumnId: dto.targetColumnId, performedById },
      'Column soft-deleted',
    );
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

    const task = await this.repo.createTask({
      projectId,
      columnId: dto.columnId,
      title: dto.title,
      description: dto.description,
      priority: dto.priority,
      assigneeIds: dto.assigneeIds,
      reporterId: userId,
      createdById: userId,
      startDate: dto.startDate,
      dueDate: dto.dueDate,
      labelIds: dto.labelIds,
    });

    this.logger.info({ projectId, taskId: task.id, createdById: userId }, 'Task created');
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

    return this.repo.findTaskById(taskId, projectId);
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
}
