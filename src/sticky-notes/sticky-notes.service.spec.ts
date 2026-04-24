import { NotFoundException } from '@nestjs/common';
import { StickyNoteColor } from '../generated/prisma/client';
import { StickyNotesRepository } from './sticky-notes.repository';
import { StickyNotesService } from './sticky-notes.service';

// ── helpers ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-01T00:00:00Z');

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    content: 'Conteúdo',
    color: StickyNoteColor.yellow,
    x: 100,
    y: 200,
    visible: true,
    minimized: false,
    zIndex: 1001,
    createdAt: NOW,
    updatedAt: NOW,
    taskLinks: [],
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof StickyNotesRepository, jest.Mock>> = {},
): jest.Mocked<StickyNotesRepository> {
  return {
    findAllByUser: jest.fn(),
    findOneByUser: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    addTaskLink: jest.fn(),
    removeTaskLink: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<StickyNotesRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(repo: jest.Mocked<StickyNotesRepository>) {
  const logger = makeLogger();
  return { service: new StickyNotesService(repo, logger as any), logger };
}

// ── findAll ────────────────────────────────────────────────────────────────────

describe('StickyNotesService.findAll', () => {
  it('retorna lista de notas do usuário', async () => {
    const notes = [makeNote(), makeNote({ id: 'note-2', content: 'Outra' })];
    const repo = makeRepo({ findAllByUser: jest.fn().mockResolvedValue(notes) });
    const { service } = makeService(repo);

    const result = await service.findAll('user-1');

    expect(repo.findAllByUser).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('note-1');
  });

  it('retorna array vazio quando usuário não tem notas', async () => {
    const repo = makeRepo({ findAllByUser: jest.fn().mockResolvedValue([]) });
    const { service } = makeService(repo);

    const result = await service.findAll('user-sem-notas');

    expect(result).toEqual([]);
  });
});

// ── create ─────────────────────────────────────────────────────────────────────

describe('StickyNotesService.create', () => {
  it('cria nota com todos os campos do DTO', async () => {
    const note = makeNote({ color: StickyNoteColor.blue, x: 50, y: 80 });
    const repo = makeRepo({ create: jest.fn().mockResolvedValue(note) });
    const { service } = makeService(repo);

    await service.create('user-1', {
      content: 'Teste',
      color: 'blue',
      x: 50,
      y: 80,
      visible: true,
      minimized: false,
      zIndex: 1001,
    });

    expect(repo.create).toHaveBeenCalledWith('user-1', {
      content: 'Teste',
      color: StickyNoteColor.blue,
      x: 50,
      y: 80,
      visible: true,
      minimized: false,
      zIndex: 1001,
    });
  });

  it('aplica defaults quando DTO está vazio', async () => {
    const note = makeNote();
    const repo = makeRepo({ create: jest.fn().mockResolvedValue(note) });
    const { service } = makeService(repo);

    await service.create('user-1', {});

    expect(repo.create).toHaveBeenCalledWith('user-1', {
      content: '',
      color: StickyNoteColor.yellow,
      x: 0,
      y: 0,
      visible: true,
      minimized: false,
      zIndex: 1000,
    });
  });

  it('retorna a nota criada pelo repositório', async () => {
    const note = makeNote({ id: 'note-novo' });
    const repo = makeRepo({ create: jest.fn().mockResolvedValue(note) });
    const { service } = makeService(repo);

    const result = await service.create('user-1', { content: 'Nova nota' });

    expect(result).toEqual(note);
  });
});

// ── update ─────────────────────────────────────────────────────────────────────

describe('StickyNotesService.update', () => {
  it('atualiza nota quando usuário é o dono', async () => {
    const note = makeNote();
    const updated = makeNote({ content: 'Atualizado' });
    const repo = makeRepo({
      findOneByUser: jest.fn().mockResolvedValue(note),
      update: jest.fn().mockResolvedValue(updated),
    });
    const { service } = makeService(repo);

    const result = await service.update('note-1', 'user-1', { content: 'Atualizado' });

    expect(repo.findOneByUser).toHaveBeenCalledWith('note-1', 'user-1');
    expect(repo.update).toHaveBeenCalledWith('note-1', { content: 'Atualizado' });
    expect(result).toEqual(updated);
  });

  it('lança NotFoundException quando nota não pertence ao usuário', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.update('note-1', 'outro-user', { content: 'x' })).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lança NotFoundException quando nota não existe', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.update('inexistente', 'user-1', {})).rejects.toThrow(NotFoundException);
  });

  it('atualiza apenas campos fornecidos (PATCH parcial)', async () => {
    const note = makeNote();
    const repo = makeRepo({
      findOneByUser: jest.fn().mockResolvedValue(note),
      update: jest.fn().mockResolvedValue(note),
    });
    const { service } = makeService(repo);

    await service.update('note-1', 'user-1', { color: 'blue' });

    expect(repo.update).toHaveBeenCalledWith('note-1', { color: 'blue' });
  });

  it('pode atualizar posição (drag-and-drop)', async () => {
    const note = makeNote();
    const repo = makeRepo({
      findOneByUser: jest.fn().mockResolvedValue(note),
      update: jest.fn().mockResolvedValue(makeNote({ x: 300, y: 400 })),
    });
    const { service } = makeService(repo);

    await service.update('note-1', 'user-1', { x: 300, y: 400 });

    expect(repo.update).toHaveBeenCalledWith('note-1', { x: 300, y: 400 });
  });
});

// ── delete ─────────────────────────────────────────────────────────────────────

describe('StickyNotesService.delete', () => {
  it('faz soft delete quando usuário é o dono', async () => {
    const note = makeNote();
    const repo = makeRepo({
      findOneByUser: jest.fn().mockResolvedValue(note),
      softDelete: jest.fn().mockResolvedValue(undefined),
    });
    const { service } = makeService(repo);

    await service.delete('note-1', 'user-1');

    expect(repo.findOneByUser).toHaveBeenCalledWith('note-1', 'user-1');
    expect(repo.softDelete).toHaveBeenCalledWith('note-1');
  });

  it('lança NotFoundException quando nota não pertence ao usuário', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.delete('note-1', 'outro-user')).rejects.toThrow(NotFoundException);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('lança NotFoundException quando nota inexistente', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.delete('inexistente', 'user-1')).rejects.toThrow(NotFoundException);
  });
});

// ── addTaskLink ────────────────────────────────────────────────────────────────

describe('StickyNotesService.addTaskLink', () => {
  it('vincula tarefa à nota quando usuário é o dono', async () => {
    const note = makeNote();
    const link = { noteId: 'note-1', taskId: 'task-1' };
    const repo = makeRepo({
      findOneByUser: jest.fn().mockResolvedValue(note),
      addTaskLink: jest.fn().mockResolvedValue(link),
    });
    const { service } = makeService(repo);

    const result = await service.addTaskLink('note-1', 'task-1', 'user-1');

    expect(repo.findOneByUser).toHaveBeenCalledWith('note-1', 'user-1');
    expect(repo.addTaskLink).toHaveBeenCalledWith('note-1', 'task-1');
    expect(result).toEqual(link);
  });

  it('lança NotFoundException quando nota não pertence ao usuário', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.addTaskLink('note-1', 'task-1', 'outro-user')).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.addTaskLink).not.toHaveBeenCalled();
  });

  it('é idempotente: delega upsert ao repositório', async () => {
    const note = makeNote();
    const repo = makeRepo({
      findOneByUser: jest.fn().mockResolvedValue(note),
      addTaskLink: jest.fn().mockResolvedValue({ noteId: 'note-1', taskId: 'task-1' }),
    });
    const { service } = makeService(repo);

    await service.addTaskLink('note-1', 'task-1', 'user-1');
    await service.addTaskLink('note-1', 'task-1', 'user-1');

    expect(repo.addTaskLink).toHaveBeenCalledTimes(2);
  });
});

// ── removeTaskLink ─────────────────────────────────────────────────────────────

describe('StickyNotesService.removeTaskLink', () => {
  it('desvincula tarefa quando usuário é o dono', async () => {
    const note = makeNote();
    const repo = makeRepo({
      findOneByUser: jest.fn().mockResolvedValue(note),
      removeTaskLink: jest.fn().mockResolvedValue({ count: 1 }),
    });
    const { service } = makeService(repo);

    await service.removeTaskLink('note-1', 'task-1', 'user-1');

    expect(repo.findOneByUser).toHaveBeenCalledWith('note-1', 'user-1');
    expect(repo.removeTaskLink).toHaveBeenCalledWith('note-1', 'task-1');
  });

  it('lança NotFoundException quando nota não pertence ao usuário', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.removeTaskLink('note-1', 'task-1', 'outro-user')).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.removeTaskLink).not.toHaveBeenCalled();
  });
});

// ── isolamento entre usuários ──────────────────────────────────────────────────

describe('StickyNotesService — isolamento entre usuários', () => {
  it('user-A não consegue atualizar nota de user-B', async () => {
    const repo = makeRepo({
      // findOneByUser com userId='user-A' retorna null (nota pertence a user-B)
      findOneByUser: jest.fn().mockResolvedValue(null),
    });
    const { service } = makeService(repo);

    await expect(service.update('note-de-B', 'user-A', { content: 'hack' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('user-A não consegue deletar nota de user-B', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.delete('note-de-B', 'user-A')).rejects.toThrow(NotFoundException);
  });

  it('user-A não consegue vincular tarefa em nota de user-B', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.addTaskLink('note-de-B', 'task-1', 'user-A')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('user-A não consegue desvincular tarefa de nota de user-B', async () => {
    const repo = makeRepo({ findOneByUser: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.removeTaskLink('note-de-B', 'task-1', 'user-A')).rejects.toThrow(
      NotFoundException,
    );
  });
});
