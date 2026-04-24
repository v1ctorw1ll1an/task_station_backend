import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { StickyNoteColor } from '../generated/prisma/client';
import { StickyNotesRepository } from './sticky-notes.repository';
import { CreateStickyNoteDto } from './dto/create-sticky-note.dto';
import { UpdateStickyNoteDto } from './dto/update-sticky-note.dto';

@Injectable()
export class StickyNotesService {
  constructor(
    private readonly repo: StickyNotesRepository,
    @InjectPinoLogger(StickyNotesService.name)
    private readonly logger: PinoLogger,
  ) {}

  findAll(userId: string) {
    return this.repo.findAllByUser(userId);
  }

  create(userId: string, dto: CreateStickyNoteDto) {
    const note = this.repo.create(userId, {
      content: dto.content ?? '',
      color: (dto.color as StickyNoteColor) ?? StickyNoteColor.yellow,
      x: dto.x ?? 0,
      y: dto.y ?? 0,
      visible: dto.visible ?? true,
      minimized: dto.minimized ?? false,
      zIndex: dto.zIndex ?? 1000,
    });
    this.logger.info({ userId }, 'Sticky note created');
    return note;
  }

  async update(id: string, userId: string, dto: UpdateStickyNoteDto) {
    await this.assertOwnership(id, userId);
    return this.repo.update(id, dto);
  }

  async delete(id: string, userId: string) {
    await this.assertOwnership(id, userId);
    await this.repo.softDelete(id);
    this.logger.info({ userId, noteId: id }, 'Sticky note deleted');
  }

  async addTaskLink(noteId: string, taskId: string, userId: string) {
    await this.assertOwnership(noteId, userId);
    return this.repo.addTaskLink(noteId, taskId);
  }

  async removeTaskLink(noteId: string, taskId: string, userId: string) {
    await this.assertOwnership(noteId, userId);
    await this.repo.removeTaskLink(noteId, taskId);
  }

  private async assertOwnership(noteId: string, userId: string) {
    const note = await this.repo.findOneByUser(noteId, userId);
    if (!note) throw new NotFoundException('Nota não encontrada');
  }
}
