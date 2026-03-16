import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { MailerModule } from '../mailer/mailer.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SuperadminController } from './superadmin.controller';
import { SuperadminRepository } from './superadmin.repository';
import { SuperadminService } from './superadmin.service';
import { NotificacaoModule } from '../notificacao/notificacao.module';

@Module({
  imports: [PrismaModule, MailerModule, AuthModule, ConfigModule, NotificacaoModule],
  controllers: [SuperadminController],
  providers: [SuperadminRepository, SuperadminService],
})
export class SuperadminModule {}
