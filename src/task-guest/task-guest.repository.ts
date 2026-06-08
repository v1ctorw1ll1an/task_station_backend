import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TASK_HISTORY_MAX } from '../common/limits';

export interface CreateTaskGuestData {
  taskId: string;
  name: string;
  phoneE164: string;
  email: string | null;
  tokenHash: string;
  rawToken: string;
  invitedById: string;
  expiresAt: Date | null;
}

@Injectable()
export class TaskGuestRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveTaskById(taskId: string) {
    return this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, title: true, projectId: true },
    });
  }

  createGuest(data: CreateTaskGuestData) {
    return this.prisma.taskGuest.create({
      data: {
        taskId: data.taskId,
        name: data.name,
        phoneE164: data.phoneE164,
        email: data.email,
        tokenHash: data.tokenHash,
        rawToken: data.rawToken,
        invitedById: data.invitedById,
        expiresAt: data.expiresAt,
      },
    });
  }

  extendGuestExpiration(guestId: string, expiresAt: Date | null) {
    return this.prisma.taskGuest.update({
      where: { id: guestId },
      data: { expiresAt },
    });
  }

  countActiveGuestsByTask(taskId: string): Promise<number> {
    return this.prisma.taskGuest.count({
      where: { taskId, deletedAt: null },
    });
  }

  listActiveGuestsByTask(taskId: string) {
    return this.prisma.taskGuest.findMany({
      where: { taskId, deletedAt: null },
      orderBy: { invitedAt: 'asc' },
      select: {
        id: true,
        name: true,
        phoneE164: true,
        email: true,
        invitedAt: true,
        expiresAt: true,
        lastAccessedAt: true,
        linkEnabled: true,
        rawToken: true,
      },
    });
  }

  setLinkEnabled(guestId: string, enabled: boolean) {
    return this.prisma.taskGuest.update({
      where: { id: guestId },
      data: { linkEnabled: enabled },
    });
  }

  findTaskReporter(taskId: string) {
    return this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, reporterId: true },
    });
  }

  findActiveGuestById(guestId: string) {
    return this.prisma.taskGuest.findFirst({
      where: { id: guestId, deletedAt: null },
      select: { id: true, taskId: true },
    });
  }

  softDeleteGuest(guestId: string) {
    return this.prisma.taskGuest.update({
      where: { id: guestId },
      data: { deletedAt: new Date() },
    });
  }

  findActiveGuestByTokenHash(tokenHash: string) {
    return this.prisma.taskGuest.findFirst({
      where: { tokenHash, deletedAt: null },
      select: {
        id: true,
        taskId: true,
        expiresAt: true,
        linkEnabled: true,
        task: {
          select: {
            id: true,
            projectId: true,
            deletedAt: true,
            project: { select: { id: true, deletedAt: true } },
          },
        },
      },
    });
  }

  touchLastAccessed(guestId: string) {
    return this.prisma.taskGuest.update({
      where: { id: guestId },
      data: { lastAccessedAt: new Date() },
    });
  }

  findGuestWithTask(guestId: string) {
    return this.prisma.taskGuest.findFirst({
      where: { id: guestId, deletedAt: null },
      select: {
        id: true,
        taskId: true,
        name: true,
        phoneE164: true,
        tokenHash: true,
        rawToken: true,
        task: { select: { id: true, title: true } },
      },
    });
  }

  rotateGuestToken(guestId: string, tokenHash: string, rawToken: string) {
    return this.prisma.taskGuest.update({
      where: { id: guestId },
      data: { tokenHash, rawToken },
    });
  }

  async findColumnNamesByIds(ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const rows = await this.prisma.column.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  findHistoryEntriesForTask(
    taskId: string,
    ids: string[],
  ): Promise<
    Array<{
      id: string;
      field: string;
      oldValue: string | null;
      newValue: string | null;
      changedAt: Date;
    }>
  > {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.taskHistory.findMany({
      where: { taskId, id: { in: ids } },
      orderBy: { changedAt: 'asc' },
      select: {
        id: true,
        field: true,
        oldValue: true,
        newValue: true,
        changedAt: true,
      },
    });
  }

  findProjectWorkspaceId(projectId: string) {
    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { workspaceId: true },
    });
  }

  async searchDistinctGuestsInWorkspace(workspaceId: string, q: string, limit = 20) {
    const where: Prisma.TaskGuestWhereInput = {
      deletedAt: null,
      task: { project: { workspaceId, deletedAt: null }, deletedAt: null },
    };
    if (q.length > 0) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { phoneE164: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.taskGuest.findMany({
      where,
      select: { name: true, phoneE164: true, email: true, invitedAt: true },
      orderBy: { invitedAt: 'desc' },
    });
    const seen = new Set<string>();
    const out: Array<{ name: string; phoneE164: string; email: string | null }> = [];
    for (const row of rows) {
      if (seen.has(row.phoneE164)) continue;
      seen.add(row.phoneE164);
      out.push({ name: row.name, phoneE164: row.phoneE164, email: row.email });
      if (out.length >= limit) break;
    }
    return out;
  }

  findColumnByIdInProject(columnId: string, projectId: string) {
    return this.prisma.column.findFirst({
      where: { id: columnId, projectId, deletedAt: null },
      select: { id: true },
    });
  }

  async applyPublicTaskUpdate(
    taskId: string,
    guestId: string,
    data: Prisma.TaskUpdateInput,
    historyEntries: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
    labelChanges?: { add: string[]; remove: string[] },
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.task.update({ where: { id: taskId }, data });
      }
      if (labelChanges) {
        if (labelChanges.remove.length > 0) {
          await tx.taskLabel.deleteMany({
            where: { taskId, labelId: { in: labelChanges.remove } },
          });
        }
        if (labelChanges.add.length > 0) {
          await tx.taskLabel.createMany({
            data: labelChanges.add.map((labelId) => ({ taskId, labelId })),
            skipDuplicates: true,
          });
        }
      }
      if (historyEntries.length > 0) {
        await tx.taskHistory.createMany({
          data: historyEntries.map((entry) => ({
            taskId,
            guestId,
            userId: null,
            field: entry.field,
            oldValue: entry.oldValue,
            newValue: entry.newValue,
          })),
        });
      }
    });
    if (historyEntries.length > 0) {
      await this.pruneTaskHistory(taskId, TASK_HISTORY_MAX);
    }
  }

  async createGuestHistories(
    taskId: string,
    guestId: string,
    entries: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
  ) {
    if (entries.length === 0) return { count: 0 };
    const result = await this.prisma.taskHistory.createMany({
      data: entries.map((entry) => ({
        taskId,
        guestId,
        userId: null,
        field: entry.field,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
      })),
    });
    await this.pruneTaskHistory(taskId, TASK_HISTORY_MAX);
    return result;
  }

  /**
   * Ring buffer do histórico: mantém apenas as `keep` entradas mais recentes
   * da task e deleta as mais antigas. Mesma lógica de
   * `ProjetoRepository.pruneTaskHistory` — replicada para evitar acoplamento
   * entre módulos. Ordenação `[changedAt desc, id desc]` casa com a leitura.
   */
  private async pruneTaskHistory(taskId: string, keep: number) {
    const survivors = await this.prisma.taskHistory.findMany({
      where: { taskId },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: keep,
      select: { id: true },
    });
    if (survivors.length < keep) return;
    await this.prisma.taskHistory.deleteMany({
      where: { taskId, id: { notIn: survivors.map((s) => s.id) } },
    });
  }

  findProjectColumns(projectId: string) {
    return this.prisma.column.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { order: 'asc' },
      select: { id: true, name: true, color: true, isDone: true },
    });
  }

  findProjectLabels(projectId: string) {
    return this.prisma.label.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true },
    });
  }

  async findLabelIdsInProject(labelIds: string[], projectId: string): Promise<string[]> {
    if (labelIds.length === 0) return [];
    const rows = await this.prisma.label.findMany({
      where: { id: { in: labelIds }, projectId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  createGuestChecklist(taskId: string, title: string, order: number) {
    return this.prisma.taskChecklist.create({
      data: { taskId, title, order, completed: false },
      select: { id: true, title: true, completed: true, order: true },
    });
  }

  createGuestComment(taskId: string, guestId: string, content: string) {
    return this.prisma.taskComment.create({
      data: { taskId, guestId, content },
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        guestId: true,
        user: { select: { id: true, name: true, photoUrl: true } },
        guest: { select: { id: true, name: true } },
      },
    });
  }

  findPublicTaskById(taskId: string) {
    return this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: {
        id: true,
        taskNumber: true,
        title: true,
        description: true,
        priority: true,
        startDate: true,
        dueDate: true,
        allDay: true,
        timezone: true,
        order: true,
        column: { select: { id: true, name: true, color: true, isDone: true } },
        taskAssignees: {
          select: { user: { select: { name: true, photoUrl: true } } },
        },
        taskLabels: {
          select: { label: { select: { id: true, name: true, color: true } } },
        },
        taskChecklists: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
          select: { id: true, title: true, completed: true, order: true },
        },
        taskGuests: {
          where: { deletedAt: null },
          orderBy: { invitedAt: 'asc' },
          select: { id: true, name: true },
        },
      },
    });
  }
}
