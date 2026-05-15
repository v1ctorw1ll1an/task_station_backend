import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateTaskGuestData {
  taskId: string;
  name: string;
  phoneE164: string;
  email: string | null;
  tokenHash: string;
  invitedById: string;
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
        invitedById: data.invitedById,
      },
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
        lastAccessedAt: true,
      },
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
        task: { select: { id: true, title: true } },
      },
    });
  }

  rotateGuestToken(guestId: string, tokenHash: string) {
    return this.prisma.taskGuest.update({
      where: { id: guestId },
      data: { tokenHash },
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

  applyPublicTaskUpdate(
    taskId: string,
    guestId: string,
    data: Prisma.TaskUpdateInput,
    historyEntries: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data });
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
        order: true,
        column: { select: { id: true, name: true, color: true, isDone: true } },
        taskAssignees: {
          select: { user: { select: { name: true, photoUrl: true } } },
        },
        taskLabels: {
          select: { label: { select: { name: true, color: true } } },
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
