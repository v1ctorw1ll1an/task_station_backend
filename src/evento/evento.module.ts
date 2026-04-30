import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventoController } from './evento.controller';
import { EventoRepository } from './evento.repository';
import { EventoService } from './evento.service';
import { ReminderDispatcherService } from './reminder-dispatcher.service';

@Module({
  imports: [PrismaModule],
  controllers: [EventoController],
  providers: [EventoRepository, EventoService, ReminderDispatcherService],
  exports: [EventoService],
})
export class EventoModule {}
