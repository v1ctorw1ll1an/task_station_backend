import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ConviteModule } from '../convite/convite.module';
import { MailerModule } from '../mailer/mailer.module';
import { NotificacaoModule } from '../notificacao/notificacao.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EmpresaController } from './empresa.controller';
import { EmpresaRepository } from './empresa.repository';
import { EmpresaService } from './empresa.service';

@Module({
  imports: [
    PrismaModule,
    MailerModule,
    AuthModule,
    ConfigModule,
    NotificacaoModule,
    BillingModule,
    ConviteModule,
  ],
  controllers: [EmpresaController],
  providers: [EmpresaRepository, EmpresaService],
})
export class EmpresaModule {}
