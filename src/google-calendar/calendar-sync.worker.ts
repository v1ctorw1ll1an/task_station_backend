import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CalendarSyncJobKind } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarSyncEnqueuer } from './calendar-sync.enqueuer';
import { CalendarSyncService } from './calendar-sync.service';
import { GoogleApiClient, GoogleAuthRevokedError } from './google-api.client';
import { GoogleCalendarConnectionService } from './google-calendar-connection.service';
import { GoogleCalendarConfig } from './google-calendar.config';
import { MAX_JOB_ATTEMPTS, nextRetryDelayMs } from './sync-rules';

const BATCH_SIZE = 25;
/** Trava do job reivindicado — maior que o pior full resync esperado. */
const LOCK_MINUTES = 15;
/** Sem webhook (dev), cada calendário é relido a cada 15 min (Q13). */
const POLL_INTERVAL_MS = 15 * 60_000;
const RENEW_WINDOW_MS = 24 * 3600_000;

interface ClaimedJob {
  id: string;
  userId: string;
  kind: CalendarSyncJobKind;
  refId: string;
  attempts: number;
  enqueuedAt: Date;
}

/**
 * Consome o outbox `calendar_sync_jobs` (não há fila no projeto). A reivindicação é
 * `FOR UPDATE SKIP LOCKED` + `locked_until`, então duas instâncias não pegam o mesmo
 * job e um processo que morreu no meio libera o job sozinho quando a trava vence.
 */
@Injectable()
export class CalendarSyncWorker {
  private readonly cfg: GoogleCalendarConfig;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: CalendarSyncService,
    private readonly connections: GoogleCalendarConnectionService,
    private readonly enqueuer: CalendarSyncEnqueuer,
    private readonly google: GoogleApiClient,
    config: ConfigService,
    @InjectPinoLogger(CalendarSyncWorker.name)
    private readonly logger: PinoLogger,
  ) {
    this.cfg = new GoogleCalendarConfig(config);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!this.cfg.enabled || this.running) return;
    this.running = true;
    try {
      await this.drain();
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'Falha no worker de sincronização');
    } finally {
      this.running = false;
    }
  }

  /** Processa lotes até esvaziar o que está vencido (limite de 10 lotes por tick). */
  async drain(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const jobs = await this.claim();
      if (jobs.length === 0) break;
      // Um usuário por vez, em ordem: evita push e pull do mesmo usuário se cruzando.
      const byUser = new Map<string, ClaimedJob[]>();
      for (const j of jobs) byUser.set(j.userId, [...(byUser.get(j.userId) ?? []), j]);
      for (const userJobs of byUser.values()) {
        for (const job of userJobs) await this.process(job);
      }
      total += jobs.length;
    }
    return total;
  }

  private async claim(): Promise<ClaimedJob[]> {
    return this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE calendar_sync_jobs
         SET locked_until = now() + make_interval(mins => ${LOCK_MINUTES}::int)
       WHERE id IN (
         SELECT id FROM calendar_sync_jobs
          WHERE run_after <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY run_after
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id AS "userId", kind::text AS kind, ref_id AS "refId",
                attempts, enqueued_at AS "enqueuedAt"`;
  }

  private async process(job: ClaimedJob): Promise<void> {
    try {
      await this.sync.runJob(job);
      // Só apaga se ninguém re-enfileirou durante a execução; senão libera para rodar de novo.
      const { count } = await this.prisma.calendarSyncJob.deleteMany({
        where: { id: job.id, enqueuedAt: job.enqueuedAt },
      });
      if (count === 0) {
        await this.prisma.calendarSyncJob.updateMany({
          where: { id: job.id },
          data: { lockedUntil: null, attempts: 0, lastError: null },
        });
      }
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = (err as Error).message?.slice(0, 500) ?? 'erro';
      this.logger.warn(
        {
          jobId: job.id,
          userId: job.userId,
          kind: job.kind,
          refId: job.refId,
          attempts,
          err: message,
        },
        'Job de sincronização falhou',
      );
      if (attempts >= MAX_JOB_ATTEMPTS) {
        await this.prisma.calendarSyncJob.deleteMany({ where: { id: job.id } });
        await this.prisma.googleCalendarConnection.updateMany({
          where: { userId: job.userId },
          data: {
            lastError:
              'Alguns itens não sincronizaram. Tentaremos de novo na próxima sincronização completa.',
          },
        });
        return;
      }
      await this.prisma.calendarSyncJob.updateMany({
        where: { id: job.id },
        data: {
          attempts,
          lastError: message,
          lockedUntil: null,
          runAfter: new Date(Date.now() + nextRetryDelayMs(attempts)),
        },
      });
    }
  }

  /** Renova canais que vencem em < 24 h; sem webhook, agenda a leitura periódica. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async maintainChannels(): Promise<void> {
    if (!this.cfg.enabled) return;
    try {
      const sources = await this.prisma.googleCalendarSource.findMany({
        where: {
          connection: { status: 'active' },
          OR: [{ isTaskdyCalendar: true }, { importEnabled: true }],
        },
        include: { connection: true },
      });

      if (!this.cfg.webhookUrl) {
        const staleBefore = Date.now() - POLL_INTERVAL_MS;
        for (const s of sources) {
          if (!s.lastPulledAt || s.lastPulledAt.getTime() < staleBefore) {
            await this.enqueuer.enqueue(s.connection.userId, 'pull_source', s.id);
          }
        }
        return;
      }

      const renewBefore = Date.now() + RENEW_WINDOW_MS;
      for (const s of sources) {
        if (s.channelExpiresAt && s.channelExpiresAt.getTime() > renewBefore) continue;
        try {
          await this.connections.ensureWatch(this.google.calendarFor(s.connection), s);
        } catch (err) {
          if (err instanceof GoogleAuthRevokedError) {
            await this.connections.markRevoked(s.connection.userId);
            continue;
          }
          this.logger.warn(
            { sourceId: s.id, err: (err as Error).message },
            'Falha ao renovar canal',
          );
        }
      }
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'Falha na manutenção de canais');
    }
  }

  /** Reconciliação diária: recupera notificações perdidas e empresas reativadas (Q18). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async dailyResync(): Promise<void> {
    if (!this.cfg.enabled) return;
    const conns = await this.prisma.googleCalendarConnection.findMany({
      where: { status: 'active' },
      select: { userId: true },
    });
    for (const c of conns) await this.enqueuer.enqueue(c.userId, 'full_resync');
    this.logger.info({ connections: conns.length }, 'Resync diário do Google agendado');
  }
}
