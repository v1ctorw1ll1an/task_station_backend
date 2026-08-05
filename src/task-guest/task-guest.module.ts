import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjetoModule } from '../projeto/projeto.module';
import { ProjetoMemberGuard } from '../projeto/guards/projeto-member.guard';
import { GuestTokenGuard } from './guards/guest-token.guard';
import { TaskGuestController } from './task-guest.controller';
import { TaskGuestPublicController } from './task-guest.public.controller';
import { TaskGuestRepository } from './task-guest.repository';
import { TaskGuestService } from './task-guest.service';

@Module({
  imports: [PrismaModule, ProjetoModule, BillingModule],
  controllers: [TaskGuestController, TaskGuestPublicController],
  providers: [TaskGuestService, TaskGuestRepository, ProjetoMemberGuard, GuestTokenGuard],
  exports: [TaskGuestService, TaskGuestRepository, GuestTokenGuard],
})
export class TaskGuestModule {}
