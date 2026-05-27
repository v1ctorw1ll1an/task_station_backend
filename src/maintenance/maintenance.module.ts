import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SoftDeletePurgeService } from './soft-delete-purge.service';

@Module({
  imports: [PrismaModule],
  providers: [SoftDeletePurgeService],
  exports: [SoftDeletePurgeService],
})
export class MaintenanceModule {}
