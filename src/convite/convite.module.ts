import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BillingModule } from '../billing/billing.module';
import { MailerModule } from '../mailer/mailer.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ConviteController } from './convite.controller';
import { ConviteRepository } from './convite.repository';
import { ConviteService } from './convite.service';

@Module({
  imports: [PrismaModule, ConfigModule, MailerModule, BillingModule],
  controllers: [ConviteController],
  providers: [ConviteRepository, ConviteService],
  exports: [ConviteService],
})
export class ConviteModule {}
