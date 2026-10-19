import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CalendarSyncJobKind, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleCalendarConfig } from './google-calendar.config';
import { GoogleSyncSettingsService } from './google-sync-settings.service';
import { isPushAllowed } from './sync-rules';

/**
 * Porta de entrada dos ganchos de mutação (evento, tarefa, convidado): descobre quem
 * tem conexão ativa e é afetado, e grava jobs no outbox. Nada de Google no request, e
 * **nunca lança** — falhar a sincronização não pode falhar a mutação do usuário.
 */
@Injectable()
export class CalendarSyncEnqueuer {
  private readonly cfg: GoogleCalendarConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GoogleSyncSettingsService,
    config: ConfigService,
    @InjectPinoLogger(CalendarSyncEnqueuer.name)
    private readonly logger: PinoLogger,
  ) {
    this.cfg = new GoogleCalendarConfig(config);
  }

  /** Dono + convidados atuais + quem já tem cópia (convidado removido sai do Google). */
  async enqueueForEvent(eventId: string): Promise<void> {
    if (!this.cfg.enabled) return;
    try {
      if (!(await this.pushEnabled())) return;
      const [ev, links] = await Promise.all([
        this.prisma.calendarEvent.findUnique({
          where: { id: eventId },
          select: { ownerId: true, attendees: { select: { userId: true } } },
        }),
        this.prisma.googleEventLink.findMany({
          where: { calendarEventId: eventId },
          select: { connection: { select: { userId: true } } },
        }),
      ]);
      const candidates = new Set<string>(links.map((l) => l.connection.userId));
      if (ev) {
        candidates.add(ev.ownerId);
        ev.attendees.forEach((a) => candidates.add(a.userId));
      }
      await this.enqueueForConnectedUsers([...candidates], 'push_event', eventId);
    } catch (err) {
      this.logger.warn({ eventId, err: (err as Error).message }, 'Falha ao enfileirar evento');
    }
  }

  /** Responsáveis atuais + quem já tem cópia (desatribuído sai do Google — Q11). */
  async enqueueForTask(taskId: string): Promise<void> {
    if (!this.cfg.enabled) return;
    try {
      if (!(await this.pushEnabled())) return;
      const [assignees, links] = await Promise.all([
        this.prisma.taskAssignee.findMany({ where: { taskId }, select: { userId: true } }),
        this.prisma.googleEventLink.findMany({
          where: { taskId },
          select: { connection: { select: { userId: true } } },
        }),
      ]);
      const candidates = new Set<string>([
        ...assignees.map((a) => a.userId),
        ...links.map((l) => l.connection.userId),
      ]);
      await this.enqueueForConnectedUsers([...candidates], 'push_task', taskId);
    } catch (err) {
      this.logger.warn({ taskId, err: (err as Error).message }, 'Falha ao enfileirar tarefa');
    }
  }

  /**
   * Só Google → TaskDY: mutação local não vira job. Ao religar o envio, o resync
   * completo agendado pelo painel manda o que ficou para trás.
   */
  private async pushEnabled(): Promise<boolean> {
    return isPushAllowed(await this.settings.getDirection());
  }

  private async enqueueForConnectedUsers(
    userIds: string[],
    kind: CalendarSyncJobKind,
    refId: string,
  ): Promise<void> {
    if (userIds.length === 0) return;
    const connected = await this.prisma.googleCalendarConnection.findMany({
      where: { userId: { in: userIds }, status: 'active' },
      select: { userId: true },
    });
    for (const { userId } of connected) await this.enqueue(userId, kind, refId);
  }

  /**
   * Upsert pela chave de dedupe. Re-enfileirar um job pendente só adianta o
   * `runAfter` e renova `enqueuedAt` — o worker percebe e roda de novo.
   */
  async enqueue(userId: string, kind: CalendarSyncJobKind, refId = '', delayMs = 0): Promise<void> {
    const now = new Date();
    const runAfter = new Date(now.getTime() + delayMs);
    try {
      await this.prisma.calendarSyncJob.upsert({
        where: { userId_kind_refId: { userId, kind, refId } },
        create: { userId, kind, refId, runAfter, enqueuedAt: now },
        update: { runAfter, enqueuedAt: now },
      });
    } catch (err) {
      // Corrida entre dois upserts do mesmo job: o outro já gravou, está coberto.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
  }
}
