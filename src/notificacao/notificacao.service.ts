import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma, NotificationType } from '../generated/prisma/client';
import { NotificacaoRepository } from './notificacao.repository';
import { NotificacaoGateway } from './notificacao.gateway';
import { UpdatePreferenceDto } from './dto/update-preference.dto';

export interface NotifyInput {
  type: NotificationType;
  recipientId: string;
  title: string;
  body: string;
  actorId?: string;
  taskId?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

const PREF_KEY_MAP: Record<NotificationType, string> = {
  ADMIN_BROADCAST: 'adminBroadcast',
  MENTION: 'mention',
  TASK_ASSIGNED: 'taskAssigned',
  TASK_COMMENT: 'taskComment',
  TASK_UPDATED: 'taskUpdated',
};

@Injectable()
export class NotificacaoService {
  constructor(
    private readonly repo: NotificacaoRepository,
    private readonly gateway: NotificacaoGateway,
    @InjectPinoLogger(NotificacaoService.name) private readonly logger: PinoLogger,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    // Don't notify the actor of their own actions
    if (input.actorId && input.actorId === input.recipientId) return;

    const pref = await this.repo.getOrCreatePreference(input.recipientId);
    const prefKey = PREF_KEY_MAP[input.type] as keyof typeof pref;
    if (!pref[prefKey]) return;

    const notification = await this.repo.create({
      recipient: { connect: { id: input.recipientId } },
      type: input.type,
      title: input.title,
      body: input.body,
      ...(input.actorId ? { actor: { connect: { id: input.actorId } } } : {}),
      ...(input.taskId ? { task: { connect: { id: input.taskId } } } : {}),
      ...(input.projectId ? { project: { connect: { id: input.projectId } } } : {}),
      ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
    });

    this.gateway.emitToUser(input.recipientId, 'notification:new', notification);
    this.logger.debug({ recipientId: input.recipientId, type: input.type }, 'Notification sent');
  }

  async notifyMany(inputs: NotifyInput[]): Promise<void> {
    if (inputs.length === 0) return;

    // Filter out self-notifications
    const filtered = inputs.filter((i) => !i.actorId || i.actorId !== i.recipientId);
    if (filtered.length === 0) return;

    const recipientIds = [...new Set(filtered.map((i) => i.recipientId))];
    const prefs = await this.repo.findPreferencesForUsers(recipientIds);
    const prefMap = new Map(prefs.map((p) => [p.userId, p]));

    const allowed = filtered.filter((input) => {
      const pref = prefMap.get(input.recipientId);
      // If no pref row exists, defaults are all true
      if (!pref) return true;
      const prefKey = PREF_KEY_MAP[input.type] as keyof typeof pref;
      return pref[prefKey];
    });

    if (allowed.length === 0) return;

    // Bulk insert
    await this.repo.createMany(
      allowed.map((i) => ({
        recipientId: i.recipientId,
        type: i.type,
        title: i.title,
        body: i.body,
        actorId: i.actorId ?? null,
        taskId: i.taskId ?? null,
        projectId: i.projectId ?? null,
        metadata: i.metadata ? (i.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
      })),
    );

    // Emit individually — we don't have the full row with actor join after createMany,
    // so emit a minimal payload that the client can display
    for (const input of allowed) {
      this.gateway.emitToUser(input.recipientId, 'notification:new', {
        type: input.type,
        title: input.title,
        body: input.body,
      });
    }
  }

  async broadcast(
    actorId: string,
    title: string,
    body: string,
    targetUserId?: string,
    companyIds?: string[],
  ): Promise<void> {
    if (targetUserId) {
      await this.notify({
        type: NotificationType.ADMIN_BROADCAST,
        recipientId: targetUserId,
        actorId,
        title,
        body,
      });
      return;
    }

    if (companyIds && companyIds.length > 0) {
      const userIds = await this.repo.findUserIdsByCompanies(companyIds);
      await this.notifyMany(
        userIds.map((id) => ({
          type: NotificationType.ADMIN_BROADCAST,
          recipientId: id,
          actorId,
          title,
          body,
        })),
      );
      this.logger.info(
        { actorId, companyIds, count: userIds.length },
        'Superadmin broadcast sent to companies',
      );
      return;
    }

    const users = await this.repo.findAllActiveUsers();
    await this.notifyMany(
      users.map((u) => ({
        type: NotificationType.ADMIN_BROADCAST,
        recipientId: u.id,
        actorId,
        title,
        body,
      })),
    );
    this.logger.info({ actorId, count: users.length }, 'Superadmin global broadcast sent');
  }

  async broadcastToCompany(
    actorId: string,
    companyId: string,
    title: string,
    body: string,
    workspaceIds?: string[],
  ): Promise<void> {
    const userIds = await this.repo.findUserIdsByCompany(companyId, workspaceIds);
    await this.notifyMany(
      userIds.map((id) => ({
        type: NotificationType.ADMIN_BROADCAST,
        recipientId: id,
        actorId,
        title,
        body,
      })),
    );
    this.logger.info(
      { actorId, companyId, workspaceIds, count: userIds.length },
      'Company broadcast sent',
    );
  }

  async listForUser(userId: string, page: number, limit: number, unreadOnly: boolean) {
    const [data, total] = await this.repo.findForUser(userId, page, limit, unreadOnly);
    return { data, total, page, limit };
  }

  async countUnread(userId: string) {
    const count = await this.repo.countUnread(userId);
    return { count };
  }

  async markAsRead(id: string, userId: string) {
    await this.repo.markAsRead(id, userId);
  }

  async markAllAsRead(userId: string) {
    await this.repo.markAllAsRead(userId);
  }

  async deleteNotification(id: string, userId: string) {
    await this.repo.softDelete(id, userId);
  }

  async clearAll(userId: string): Promise<void> {
    await this.repo.clearAll(userId);
  }

  async getPreference(userId: string) {
    return this.repo.getOrCreatePreference(userId);
  }

  async updatePreference(userId: string, dto: UpdatePreferenceDto) {
    return this.repo.updatePreference(
      userId,
      dto as Prisma.NotificationPreferenceUncheckedUpdateInput,
    );
  }
}
