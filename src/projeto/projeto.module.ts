import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjetoController } from './projeto.controller';
import { ProjetoRepository } from './projeto.repository';
import { ProjetoService } from './projeto.service';
import { ProjetoMemberGuard } from './guards/projeto-member.guard';
import { ProjetoAdminGuard } from './guards/projeto-admin.guard';

@Module({
  imports: [PrismaModule],
  controllers: [ProjetoController],
  providers: [ProjetoRepository, ProjetoService, ProjetoMemberGuard, ProjetoAdminGuard],
})
export class ProjetoModule {}
