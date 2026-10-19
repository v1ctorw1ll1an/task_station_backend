import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarSyncEnqueuer } from './calendar-sync.enqueuer';
import { GoogleCalendarConfig } from './google-calendar.config';
import { GoogleSyncSettingsService } from './google-sync-settings.service';
import { SyncDirection } from './sync-rules';

/**
 * Painel do superusuário: direção global da sincronização e números de saúde.
 */
@Injectable()
export class GoogleSyncAdminService {
  private readonly cfg: GoogleCalendarConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GoogleSyncSettingsService,
    private readonly enqueuer: CalendarSyncEnqueuer,
    config: ConfigService,
    @InjectPinoLogger(GoogleSyncAdminService.name)
    private readonly logger: PinoLogger,
  ) {
    this.cfg = new GoogleCalendarConfig(config);
  }

  async getPanel() {
    const [settings, activeConnections, pendingJobs, failingJobs] = await Promise.all([
      this.settings.get(),
      this.prisma.googleCalendarConnection.count({ where: { status: 'active' } }),
      this.prisma.calendarSyncJob.count(),
      this.prisma.calendarSyncJob.count({ where: { attempts: { gt: 0 } } }),
    ]);
    return {
      enabled: this.cfg.enabled,
      ...settings,
      stats: { activeConnections, pendingJobs, failingJobs },
    };
  }

  /**
   * Troca a direção. Ao mudar, agenda um resync completo de cada conexão ativa: o
   * syncToken avançou por cima do que foi ignorado enquanto o sentido estava
   * desligado, e só a releitura inteira da janela traz isso de volta.
   */
  async setDirection(direction: SyncDirection, userId: string) {
    const previous = await this.settings.setDirection(direction, userId);
    let resyncQueued = 0;
    if (previous !== direction && this.cfg.enabled) {
      const conns = await this.prisma.googleCalendarConnection.findMany({
        where: { status: 'active' },
        select: { userId: true },
      });
      for (const c of conns) await this.enqueuer.enqueue(c.userId, 'full_resync');
      resyncQueued = conns.length;
    }
    this.logger.info(
      { userId, previous, direction, resyncQueued },
      'Direção da sincronização com o Google alterada',
    );
    return { ...(await this.getPanel()), resyncQueued };
  }
}
