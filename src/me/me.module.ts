import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MeController } from './me.controller';
import { MeRepository } from './me.repository';
import { MeService } from './me.service';

@Module({
  imports: [PrismaModule, BillingModule],
  controllers: [MeController],
  providers: [MeRepository, MeService],
})
export class MeModule {}
