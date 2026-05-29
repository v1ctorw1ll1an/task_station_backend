import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjetoController } from './projeto.controller';
import { ProjetoRepository } from './projeto.repository';
import { ProjetoService } from './projeto.service';
import { AttachmentService } from './attachment.service';
import { AttachmentJanitorService } from './attachment-janitor.service';
import { MediaPoolService } from './media-pool.service';
import { ProjetoMemberGuard } from './guards/projeto-member.guard';
import { ProjetoAdminGuard } from './guards/projeto-admin.guard';
import { WsAuthGuard } from '../common/guards/ws-auth.guard';
import { KanbanGateway } from './kanban.gateway';
import { NotificacaoModule } from '../notificacao/notificacao.module';

@Module({
  imports: [
    PrismaModule,
    NotificacaoModule,
    MulterModule.register({ storage: memoryStorage() }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [ProjetoController],
  providers: [
    ProjetoRepository,
    ProjetoService,
    AttachmentService,
    AttachmentJanitorService,
    MediaPoolService,
    ProjetoMemberGuard,
    ProjetoAdminGuard,
    KanbanGateway,
    WsAuthGuard,
  ],
  exports: [KanbanGateway, ProjetoRepository],
})
export class ProjetoModule {}
