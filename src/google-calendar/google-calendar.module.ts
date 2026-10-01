import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { BillingModule } from '../billing/billing.module';
import { NotificacaoModule } from '../notificacao/notificacao.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CalendarSyncEnqueuer } from './calendar-sync.enqueuer';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarSyncWorker } from './calendar-sync.worker';
import { GoogleApiClient } from './google-api.client';
import { GoogleCalendarConnectionService } from './google-calendar-connection.service';
import { GoogleCalendarController } from './google-calendar.controller';
import { GoogleWebhookController } from './google-webhook.controller';
import { SyncEligibilityService } from './sync-eligibility.service';

/**
 * Integração Agenda TaskDY ↔ Google Calendar. Exporta só o `CalendarSyncEnqueuer`:
 * os módulos de evento/tarefa enfileiram e não sabem nada de Google.
 */
@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    BillingModule,
    NotificacaoModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [GoogleCalendarController, GoogleWebhookController],
  providers: [
    GoogleApiClient,
    SyncEligibilityService,
    CalendarSyncEnqueuer,
    GoogleCalendarConnectionService,
    CalendarSyncService,
    CalendarSyncWorker,
  ],
  exports: [CalendarSyncEnqueuer],
})
export class GoogleCalendarModule {}
