import {
  BadRequestException,
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

  async updateColuna(projectId: string, columnId: string, dto: UpdateColunaDto, performedById: string) {
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

  async deleteColuna(projectId: string, columnId: string, dto: DeleteColunaDto, performedById: string) {
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
      assigneeId: dto.assigneeId,
      reporterId: userId,
      createdById: userId,
      startDate: dto.startDate,
      dueDate: dto.dueDate,
    });

    this.logger.info({ projectId, taskId: task.id, createdById: userId }, 'Task created');
    return task;
  }

  async updateTask(projectId: string, taskId: string, dto: UpdateTaskDto, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    const updateData: Prisma.TaskUpdateInput = {};

    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.priority !== undefined) updateData.priority = dto.priority;
    if (dto.startDate !== undefined)
      updateData.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.dueDate !== undefined)
      updateData.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.assigneeId !== undefined) {
      updateData.assignee = dto.assigneeId
        ? { connect: { id: dto.assigneeId } }
        : { disconnect: true };
    }

    const updated = await this.repo.updateTask(taskId, updateData);
    this.logger.info({ projectId, taskId, changes: dto, performedById }, 'Task updated');
    return updated;
  }

  async moveTask(projectId: string, taskId: string, dto: MoveTaskDto, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    const column = await this.repo.findColumnById(dto.columnId, projectId);
    if (!column) {
      throw new NotFoundException('Coluna de destino não encontrada');
    }

    await this.repo.moveTask(taskId, dto.columnId, dto.afterTaskId);
    this.logger.info(
      { projectId, taskId, columnId: dto.columnId, afterTaskId: dto.afterTaskId, performedById },
      'Task moved',
    );

    return this.repo.findTaskById(taskId, projectId);
  }

  async deleteTask(projectId: string, taskId: string, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    await this.repo.softDeleteTask(taskId);
    this.logger.info({ projectId, taskId, performedById }, 'Task soft-deleted');
  }

  async assignTask(projectId: string, taskId: string, dto: AssignTaskDto, performedById: string) {
    const task = await this.repo.findTaskById(taskId, projectId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    const updateData: Prisma.TaskUpdateInput = {
      assignee: dto.assigneeId
        ? { connect: { id: dto.assigneeId } }
        : { disconnect: true },
    };

    const updated = await this.repo.updateTask(taskId, updateData);
    this.logger.info(
      { projectId, taskId, assigneeId: dto.assigneeId, performedById },
      'Task assigned',
    );
    return updated;
  }

  // ── Membros ───────────────────────────────────────────────────────────────────

  async listMembers(projectId: string) {
    const project = await this.repo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    return this.repo.findWorkspaceMembersByProject(projectId);
  }
}
