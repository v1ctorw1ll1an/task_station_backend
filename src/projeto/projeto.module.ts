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
import { ProjetoMemberGuard } from './guards/projeto-member.guard';
import { ProjetoAdminGuard } from './guards/projeto-admin.guard';
import { WsAuthGuard } from './guards/ws-auth.guard';
import { KanbanGateway } from './kanban.gateway';

@Module({
  imports: [
    PrismaModule,
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
    ProjetoMemberGuard,
    ProjetoAdminGuard,
    KanbanGateway,
    WsAuthGuard,
  ],
})
export class ProjetoModule {}
