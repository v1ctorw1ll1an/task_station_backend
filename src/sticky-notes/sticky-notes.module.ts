import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StickyNotesController } from './sticky-notes.controller';
import { StickyNotesRepository } from './sticky-notes.repository';
import { StickyNotesService } from './sticky-notes.service';

@Module({
  imports: [PrismaModule],
  controllers: [StickyNotesController],
  providers: [StickyNotesRepository, StickyNotesService],
})
export class StickyNotesModule {}
