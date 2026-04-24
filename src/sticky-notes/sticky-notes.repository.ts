import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StickyNoteColor } from '../generated/prisma/client';
import type { UpdateStickyNoteDto } from './dto/update-sticky-note.dto';

const NOTE_SELECT = {
  id: true,
  content: true,
  color: true,
  x: true,
  y: true,
  visible: true,
  minimized: true,
  zIndex: true,
  createdAt: true,
  updatedAt: true,
  taskLinks: {
    select: {
      task: {
        select: {
          id: true,
          title: true,
          taskNumber: true,
          projectId: true,
          project: { select: { workspaceId: true } },
        },
      },
    },
  },
} as const;

@Injectable()
export class StickyNotesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAllByUser(userId: string) {
    return this.prisma.stickyNote.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: NOTE_SELECT,
    });
  }

  findOneByUser(id: string, userId: string) {
    return this.prisma.stickyNote.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true },
    });
  }

  create(
    userId: string,
    data: {
      content: string;
      color: StickyNoteColor;
      x: number;
      y: number;
      visible: boolean;
      minimized: boolean;
      zIndex: number;
    },
  ) {
    return this.prisma.stickyNote.create({
      data: { ...data, userId },
      select: NOTE_SELECT,
    });
  }

  update(id: string, data: UpdateStickyNoteDto) {
    return this.prisma.stickyNote.update({
      where: { id },
      data: {
        ...(data.content !== undefined && { content: data.content }),
        ...(data.color !== undefined && { color: data.color as StickyNoteColor }),
        ...(data.x !== undefined && { x: data.x }),
        ...(data.y !== undefined && { y: data.y }),
        ...(data.visible !== undefined && { visible: data.visible }),
        ...(data.minimized !== undefined && { minimized: data.minimized }),
        ...(data.zIndex !== undefined && { zIndex: data.zIndex }),
      },
      select: NOTE_SELECT,
    });
  }

  softDelete(id: string) {
    return this.prisma.stickyNote.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  addTaskLink(noteId: string, taskId: string) {
    return this.prisma.stickyNoteTaskLink.upsert({
      where: { noteId_taskId: { noteId, taskId } },
      create: { noteId, taskId },
      update: {},
    });
  }

  removeTaskLink(noteId: string, taskId: string) {
    return this.prisma.stickyNoteTaskLink.deleteMany({
      where: { noteId, taskId },
    });
  }
}
