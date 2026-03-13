import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceRepository } from './workspace.repository';
import { WorkspaceService } from './workspace.service';
import { WorkspaceCompanyAdminGuard } from './guards/workspace-company-admin.guard';
import { WorkspaceMemberGuard } from './guards/workspace-member.guard';

@Module({
  imports: [PrismaModule],
  controllers: [WorkspaceController],
  providers: [
    WorkspaceRepository,
    WorkspaceService,
    WorkspaceMemberGuard,
    WorkspaceCompanyAdminGuard,
  ],
})
export class WorkspaceModule {}
