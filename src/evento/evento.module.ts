import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificacaoModule } from '../notificacao/notificacao.module';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';
import { EventoController } from './evento.controller';
import { EventoRepository } from './evento.repository';
import { EventoService } from './evento.service';
import { ReminderDispatcherService } from './reminder-dispatcher.service';

@Module({
  imports: [PrismaModule, NotificacaoModule, BillingModule, GoogleCalendarModule],
  controllers: [EventoController],
  providers: [EventoRepository, EventoService, ReminderDispatcherService],
  exports: [EventoService],
})
export class EventoModule {}
