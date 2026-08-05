import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjetoModule } from '../projeto/projeto.module';
import {
  TaskSessionController,
  WorkspaceTaskSessionController,
  CompanyTaskSessionController,
} from './task-session.controller';
import { TaskSessionService } from './task-session.service';

@Module({
  imports: [PrismaModule, ProjetoModule, BillingModule],
  controllers: [
    TaskSessionController,
    WorkspaceTaskSessionController,
    CompanyTaskSessionController,
  ],
  providers: [TaskSessionService],
  exports: [TaskSessionService],
})
export class TaskSessionModule {}
