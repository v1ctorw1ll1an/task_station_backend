import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjetoMemberGuard } from '../projeto/guards/projeto-member.guard';
import { GuestTokenGuard } from './guards/guest-token.guard';
import { TaskGuestController } from './task-guest.controller';
import { TaskGuestPublicController } from './task-guest.public.controller';
import { TaskGuestRepository } from './task-guest.repository';
import { TaskGuestService } from './task-guest.service';

@Module({
  imports: [PrismaModule],
  controllers: [TaskGuestController, TaskGuestPublicController],
  providers: [TaskGuestService, TaskGuestRepository, ProjetoMemberGuard, GuestTokenGuard],
  exports: [TaskGuestService, TaskGuestRepository, GuestTokenGuard],
})
export class TaskGuestModule {}
