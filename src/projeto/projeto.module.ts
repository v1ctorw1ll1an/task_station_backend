import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjetoController } from './projeto.controller';
import { ProjetoRepository } from './projeto.repository';
import { ProjetoService } from './projeto.service';
import { AttachmentService } from './attachment.service';
import { ProjetoMemberGuard } from './guards/projeto-member.guard';
import { ProjetoAdminGuard } from './guards/projeto-admin.guard';

@Module({
  imports: [PrismaModule, MulterModule.register({ storage: memoryStorage() })],
  controllers: [ProjetoController],
  providers: [
    ProjetoRepository,
    ProjetoService,
    AttachmentService,
    ProjetoMemberGuard,
    ProjetoAdminGuard,
  ],
})
export class ProjetoModule {}
