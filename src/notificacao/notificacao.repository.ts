import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  isRead: true,
  readAt: true,
  createdAt: true,
  taskId: true,
  projectId: true,
  actorId: true,
  actor: { select: { id: true, name: true } },
  task: { select: { id: true, title: true } },
  project: {
    select: {
      id: true,
      name: true,
      workspaceId: true,
      icon: true,
      iconColor: true,
      workspace: { select: { name: true } },
    },
  },
} as const;

@Injectable()
export class NotificacaoRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.NotificationCreateInput) {
    return this.prisma.notification.create({ data, select: NOTIFICATION_SELECT });
  }

  createMany(data: Prisma.NotificationCreateManyInput[]) {
    return this.prisma.notification.createMany({ data });
  }

  findForUser(userId: string, page: number, limit: number, unreadOnly: boolean) {
    const where: Prisma.NotificationWhereInput = {
      recipientId: userId,
      deletedAt: null,
      ...(unreadOnly ? { isRead: false } : {}),
    };
    return Promise.all([
      this.prisma.notification.findMany({
        where,
        select: NOTIFICATION_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);
  }

  countUnread(userId: string) {
    return this.prisma.notification.count({
      where: { recipientId: userId, isRead: false, deletedAt: null },
    });
  }

  markAsRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, recipientId: userId, deletedAt: null },
      data: { isRead: true, readAt: new Date() },
    });
  }

  markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { recipientId: userId, isRead: false, deletedAt: null },
      data: { isRead: true, readAt: new Date() },
    });
  }

  softDelete(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, recipientId: userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  clearAll(userId: string) {
    return this.prisma.notification.updateMany({
      where: { recipientId: userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  getOrCreatePreference(userId: string) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  updatePreference(userId: string, data: Prisma.NotificationPreferenceUncheckedUpdateInput) {
    const createData: Prisma.NotificationPreferenceUncheckedCreateInput = {
      userId,
      adminBroadcast: typeof data.adminBroadcast === 'boolean' ? data.adminBroadcast : undefined,
      mention: typeof data.mention === 'boolean' ? data.mention : undefined,
      taskAssigned: typeof data.taskAssigned === 'boolean' ? data.taskAssigned : undefined,
      taskComment: typeof data.taskComment === 'boolean' ? data.taskComment : undefined,
      taskUpdated: typeof data.taskUpdated === 'boolean' ? data.taskUpdated : undefined,
      eventReminder: typeof data.eventReminder === 'boolean' ? data.eventReminder : undefined,
      eventReminderPopup:
        typeof data.eventReminderPopup === 'boolean' ? data.eventReminderPopup : undefined,
      notificationSound:
        typeof data.notificationSound === 'boolean' ? data.notificationSound : undefined,
      notificationBrowser:
        typeof data.notificationBrowser === 'boolean' ? data.notificationBrowser : undefined,
    };
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: createData,
      update: data,
    });
  }

  findAllActiveUsers() {
    return this.prisma.user.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true },
    });
  }

  async findUserIdsByCompanies(companyIds: string[]): Promise<string[]> {
    const memberships = await this.prisma.membership.findMany({
      where: {
        resourceType: 'company',
        resourceId: { in: companyIds },
        deletedAt: null,
        user: { isActive: true, deletedAt: null },
      },
      select: { userId: true },
    });
    return [...new Set(memberships.map((m) => m.userId))];
  }

  async findUserIdsByCompany(companyId: string, workspaceIds?: string[]): Promise<string[]> {
    let memberships: { userId: string }[];
    if (workspaceIds && workspaceIds.length > 0) {
      memberships = await this.prisma.membership.findMany({
        where: {
          resourceType: 'workspace',
          resourceId: { in: workspaceIds },
          deletedAt: null,
          user: { isActive: true, deletedAt: null },
        },
        select: { userId: true },
      });
    } else {
      const companyWorkspaces = await this.prisma.workspace.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true },
      });
      const wsIds = companyWorkspaces.map((w) => w.id);
      memberships = await this.prisma.membership.findMany({
        where: {
          deletedAt: null,
          user: { isActive: true, deletedAt: null },
          OR: [
            { resourceType: 'company', resourceId: companyId },
            ...(wsIds.length > 0
              ? [{ resourceType: 'workspace' as const, resourceId: { in: wsIds } }]
              : []),
          ],
        },
        select: { userId: true },
      });
    }
    return [...new Set(memberships.map((m) => m.userId))];
  }

  findPreferencesForUsers(userIds: string[]) {
    return this.prisma.notificationPreference.findMany({
      where: { userId: { in: userIds } },
    });
  }
}
