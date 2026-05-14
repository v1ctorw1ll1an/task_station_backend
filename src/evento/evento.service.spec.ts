import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttendeeStatus, EventVisibility, ReminderMethod } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { EventMutationScope } from './dto/event-mutation-scope.dto';
import { EventoRepository, CalendarEventWithRelations } from './evento.repository';
import { EventoService } from './evento.service';

// ── helpers ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-01T00:00:00Z');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeRepo(
  overrides: Partial<Record<keyof EventoRepository, jest.Mock>> = {},
): jest.Mocked<EventoRepository> {
  return {
    findById: jest.fn(),
    findOverlapping: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    upsertException: jest.fn(),
    findAttendee: jest.fn(),
    addAttendee: jest.fn(),
    removeAttendee: jest.fn(),
    setRsvp: jest.fn(),
    replaceReminders: jest.fn(),
    replaceGuestEmails: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<EventoRepository>;
}

function makePrisma() {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Owner' }) },
    calendarEventAttendee: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  } as any;
}

function makeMailer(): jest.Mocked<MailerService> {
  return {
    sendEventNotificationEmail: jest.fn().mockResolvedValue(undefined),
    sendEventReminderEmail: jest.fn(),
  } as unknown as jest.Mocked<MailerService>;
}

function makeService(repoOverrides: Partial<Record<keyof EventoRepository, jest.Mock>> = {}) {
  const repo = makeRepo(repoOverrides);
  const prisma = makePrisma();
  const mailer = makeMailer();
  const logger = makeLogger();
  const service = new EventoService(repo, prisma, mailer, logger as any);
  return { service, repo, prisma, mailer, logger };
}

function makeEvent(
  overrides: Partial<CalendarEventWithRelations> = {},
): CalendarEventWithRelations {
  return {
    id: 'ev-1',
    ownerId: 'owner-1',
    title: 'Reunião',
    description: null,
    location: null,
    color: null,
    allDay: false,
    startsAt: new Date('2026-05-15T13:00:00Z'),
    endsAt: new Date('2026-05-15T14:00:00Z'),
    timezone: 'America/Sao_Paulo',
    rrule: null,
    recurrenceEndAt: null,
    visibility: EventVisibility.private,
    companyId: null,
    workspaceId: null,
    taskId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    attendees: [],
    reminders: [],
    exceptions: [],
    guestEmails: [],
    ...overrides,
  } as unknown as CalendarEventWithRelations;
}

// Espera próximas microtasks (para fire-and-forget notifyAttendees)
const flush = () => new Promise((r) => setImmediate(r));

// ── findOne ────────────────────────────────────────────────────────────────────

describe('EventoService.findOne', () => {
  it('lança NotFoundException quando evento não existe', async () => {
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(service.findOne('u-1', 'ev-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lança NotFoundException quando usuário não é dono nem attendee', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'outro' })),
    });
    await expect(service.findOne('u-1', 'ev-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('retorna evento quando usuário é o dono', async () => {
    const ev = makeEvent({ ownerId: 'u-1' });
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(ev) });
    expect(await service.findOne('u-1', 'ev-1')).toBe(ev);
  });

  it('retorna evento quando usuário é attendee', async () => {
    const ev = makeEvent({
      ownerId: 'outro',
      attendees: [
        {
          userId: 'u-1',
          status: AttendeeStatus.accepted,
          user: { id: 'u-1', name: 'X', email: 'x@x', photoUrl: null },
        } as any,
      ],
    });
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(ev) });
    expect(await service.findOne('u-1', 'ev-1')).toBe(ev);
  });
});

// ── create ─────────────────────────────────────────────────────────────────────

describe('EventoService.create', () => {
  const baseDto = {
    title: 'Sprint Planning',
    description: null,
    location: null,
    color: null,
    allDay: false,
    startsAt: '2026-05-15T13:00:00Z',
    endsAt: '2026-05-15T14:00:00Z',
    timezone: 'America/Sao_Paulo',
  } as any;

  it('lança ForbiddenException quando endsAt < startsAt', async () => {
    const { service } = makeService();
    await expect(
      service.create('u-1', {
        ...baseDto,
        startsAt: '2026-05-15T14:00:00Z',
        endsAt: '2026-05-15T13:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lança ForbiddenException quando datas inválidas', async () => {
    const { service } = makeService();
    await expect(
      service.create('u-1', { ...baseDto, startsAt: 'invalid', endsAt: 'invalid' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cria evento simples (sem rrule) com defaults', async () => {
    const created = makeEvent({ id: 'ev-new' });
    const { service, repo } = makeService({ create: jest.fn().mockResolvedValue(created) });

    const result = await service.create('owner-1', baseDto);

    expect(repo.create).toHaveBeenCalledTimes(1);
    const data = repo.create.mock.calls[0][0];
    expect(data.owner).toEqual({ connect: { id: 'owner-1' } });
    expect(data.rrule).toBeNull();
    expect(data.recurrenceEndAt).toBeNull();
    expect(data.visibility).toBe(EventVisibility.private);
    expect(result).toBe(created);
  });

  it('filtra o próprio user da lista de attendeeUserIds', async () => {
    const { service, repo } = makeService({ create: jest.fn().mockResolvedValue(makeEvent()) });
    await service.create('owner-1', { ...baseDto, attendeeUserIds: ['owner-1', 'u-2', 'u-3'] });
    const data: any = repo.create.mock.calls[0][0];
    expect(data.attendees.create).toEqual([{ userId: 'u-2' }, { userId: 'u-3' }]);
  });

  it('deduplica e normaliza guestEmails (lowercase + trim)', async () => {
    const { service, repo } = makeService({ create: jest.fn().mockResolvedValue(makeEvent()) });
    await service.create('owner-1', {
      ...baseDto,
      guestEmails: ['  Foo@Bar.com ', 'foo@bar.com', 'Other@x.com'],
    });
    const data: any = repo.create.mock.calls[0][0];
    expect(data.guestEmails.create).toEqual([{ email: 'foo@bar.com' }, { email: 'other@x.com' }]);
  });

  it('aplica method padrão (notification) em reminders sem method', async () => {
    const { service, repo } = makeService({ create: jest.fn().mockResolvedValue(makeEvent()) });
    await service.create('owner-1', {
      ...baseDto,
      reminders: [{ minutesBefore: 10 }, { minutesBefore: 60, method: ReminderMethod.email }],
    });
    const data: any = repo.create.mock.calls[0][0];
    expect(data.reminders.create).toEqual([
      { minutesBefore: 10, method: ReminderMethod.notification },
      { minutesBefore: 60, method: ReminderMethod.email },
    ]);
  });

  it('rrule recorrente com COUNT calcula recurrenceEndAt', async () => {
    const { service, repo } = makeService({ create: jest.fn().mockResolvedValue(makeEvent()) });
    await service.create('owner-1', {
      ...baseDto,
      rrule: 'FREQ=DAILY;COUNT=3',
    });
    const data = repo.create.mock.calls[0][0];
    expect(data.rrule).toBe('FREQ=DAILY;COUNT=3');
    expect(data.recurrenceEndAt).toBeInstanceOf(Date);
  });

  it('rrule recorrente infinita deixa recurrenceEndAt = null', async () => {
    const { service, repo } = makeService({ create: jest.fn().mockResolvedValue(makeEvent()) });
    await service.create('owner-1', { ...baseDto, rrule: 'FREQ=WEEKLY' });
    expect(repo.create.mock.calls[0][0].recurrenceEndAt).toBeNull();
  });

  it('rrule inválida lança ForbiddenException', async () => {
    const { service } = makeService();
    await expect(
      service.create('owner-1', { ...baseDto, rrule: 'NOT_A_VALID_RRULE' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dispara notifyAttendees (mailer) em background após criação', async () => {
    const ev = makeEvent({
      attendees: [
        {
          userId: 'u-2',
          user: { id: 'u-2', name: 'Bob', email: 'bob@x.com', photoUrl: null },
        } as any,
      ],
    });
    const { service, mailer } = makeService({ create: jest.fn().mockResolvedValue(ev) });
    await service.create('owner-1', baseDto);
    await flush();
    expect(mailer.sendEventNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'bob@x.com', kind: 'created' }),
    );
  });
});

// ── update ─────────────────────────────────────────────────────────────────────

describe('EventoService.update', () => {
  it('lança NotFoundException quando evento não existe', async () => {
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(service.update('u-1', 'ev-x', {} as any, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lança ForbiddenException quando usuário não é dono', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'outro' })),
    });
    await expect(service.update('u-1', 'ev-1', {} as any, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('scope=single sem originalDate lança Forbidden', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'owner-1' })),
    });
    await expect(
      service.update('owner-1', 'ev-1', { title: 'X' } as any, {
        scope: EventMutationScope.single,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scope=single faz upsertException com overrides', async () => {
    const ev = makeEvent({ ownerId: 'owner-1' });
    const findById = jest.fn().mockResolvedValue(ev);
    const { service, repo } = makeService({ findById, upsertException: jest.fn() });

    await service.update('owner-1', 'ev-1', { title: 'Override' } as any, {
      scope: EventMutationScope.single,
      originalDate: '2026-05-15T13:00:00Z',
    });

    expect(repo.upsertException).toHaveBeenCalledWith(
      'ev-1',
      new Date('2026-05-15T13:00:00Z'),
      expect.objectContaining({
        eventId: 'ev-1',
        isCancelled: false,
        overrideTitle: 'Override',
      }),
    );
  });

  it('scope=all atualiza o evento e dispara notifyAttendees(updated)', async () => {
    const ev = makeEvent({ ownerId: 'owner-1' });
    const updated = makeEvent({
      ownerId: 'owner-1',
      title: 'Novo',
      attendees: [
        { userId: 'u-2', user: { id: 'u-2', name: 'B', email: 'b@x.com', photoUrl: null } } as any,
      ],
    });
    const findById = jest.fn().mockResolvedValueOnce(ev).mockResolvedValue(updated);
    const { service, repo, mailer } = makeService({
      findById,
      update: jest.fn().mockResolvedValue(updated),
    });

    const result = await service.update('owner-1', 'ev-1', { title: 'Novo' } as any, {});

    expect(repo.update).toHaveBeenCalledWith('ev-1', expect.objectContaining({ title: 'Novo' }));
    expect(result).toBe(updated);
    await flush();
    expect(mailer.sendEventNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'b@x.com', kind: 'updated' }),
    );
  });

  it('chama replaceReminders quando dto.reminders foi enviado', async () => {
    const ev = makeEvent({ ownerId: 'owner-1' });
    const findById = jest.fn().mockResolvedValueOnce(ev).mockResolvedValue(ev);
    const { service, repo } = makeService({
      findById,
      update: jest.fn().mockResolvedValue(ev),
      replaceReminders: jest.fn(),
    });
    await service.update('owner-1', 'ev-1', { reminders: [{ minutesBefore: 30 }] } as any, {});
    expect(repo.replaceReminders).toHaveBeenCalledWith('ev-1', [{ minutesBefore: 30 }]);
  });

  it('chama replaceGuestEmails quando dto.guestEmails foi enviado', async () => {
    const ev = makeEvent({ ownerId: 'owner-1' });
    const findById = jest.fn().mockResolvedValueOnce(ev).mockResolvedValue(ev);
    const { service, repo } = makeService({
      findById,
      update: jest.fn().mockResolvedValue(ev),
      replaceGuestEmails: jest.fn(),
    });
    await service.update('owner-1', 'ev-1', { guestEmails: ['x@y.com'] } as any, {});
    expect(repo.replaceGuestEmails).toHaveBeenCalledWith('ev-1', ['x@y.com']);
  });
});

// ── delete ─────────────────────────────────────────────────────────────────────

describe('EventoService.delete', () => {
  it('lança NotFoundException quando evento não existe', async () => {
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(service.delete('u-1', 'ev-x', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lança Forbidden quando não é dono', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'outro' })),
    });
    await expect(service.delete('u-1', 'ev-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scope=single sem originalDate lança Forbidden', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'owner-1' })),
    });
    await expect(
      service.delete('owner-1', 'ev-1', { scope: EventMutationScope.single }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scope=single faz upsertException isCancelled=true (não chama softDelete)', async () => {
    const { service, repo } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'owner-1' })),
      upsertException: jest.fn(),
      softDelete: jest.fn(),
    });
    await service.delete('owner-1', 'ev-1', {
      scope: EventMutationScope.single,
      originalDate: '2026-05-15T13:00:00Z',
    });
    expect(repo.upsertException).toHaveBeenCalledWith(
      'ev-1',
      new Date('2026-05-15T13:00:00Z'),
      expect.objectContaining({ isCancelled: true }),
    );
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('scope=all faz softDelete e dispara notifyAttendees(cancelled)', async () => {
    const ev = makeEvent({
      ownerId: 'owner-1',
      attendees: [
        { userId: 'u-2', user: { id: 'u-2', name: 'B', email: 'b@x.com', photoUrl: null } } as any,
      ],
    });
    const { service, repo, mailer } = makeService({
      findById: jest.fn().mockResolvedValue(ev),
      softDelete: jest.fn(),
    });
    await service.delete('owner-1', 'ev-1', {});
    expect(repo.softDelete).toHaveBeenCalledWith('ev-1');
    await flush();
    expect(mailer.sendEventNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cancelled' }),
    );
  });
});

// ── inviteAttendee ─────────────────────────────────────────────────────────────

describe('EventoService.inviteAttendee', () => {
  it('lança NotFoundException quando evento não existe', async () => {
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(service.inviteAttendee('u-1', 'ev-x', 'u-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lança Forbidden quando não é dono', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'outro' })),
    });
    await expect(service.inviteAttendee('u-1', 'ev-1', 'u-2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lança Forbidden quando attendeeId é o próprio dono', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'owner-1' })),
    });
    await expect(service.inviteAttendee('owner-1', 'ev-1', 'owner-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('chama repo.addAttendee no caso feliz', async () => {
    const { service, repo } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'owner-1' })),
      addAttendee: jest.fn().mockResolvedValue({ eventId: 'ev-1', userId: 'u-2' }),
    });
    await service.inviteAttendee('owner-1', 'ev-1', 'u-2');
    expect(repo.addAttendee).toHaveBeenCalledWith('ev-1', 'u-2');
  });
});

// ── removeAttendee ─────────────────────────────────────────────────────────────

describe('EventoService.removeAttendee', () => {
  it('lança NotFoundException quando evento não existe', async () => {
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(service.removeAttendee('u-1', 'ev-x', 'u-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lança Forbidden quando não é dono', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'outro' })),
    });
    await expect(service.removeAttendee('u-1', 'ev-1', 'u-2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('chama repo.removeAttendee no caso feliz', async () => {
    const { service, repo } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'owner-1' })),
      removeAttendee: jest.fn(),
    });
    await service.removeAttendee('owner-1', 'ev-1', 'u-2');
    expect(repo.removeAttendee).toHaveBeenCalledWith('ev-1', 'u-2');
  });
});

// ── rsvp ───────────────────────────────────────────────────────────────────────

describe('EventoService.rsvp', () => {
  it('lança NotFoundException quando evento não existe', async () => {
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(service.rsvp('u-1', 'ev-x', AttendeeStatus.accepted)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lança Forbidden quando user não foi convidado', async () => {
    const { service } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'outro' })),
      findAttendee: jest.fn().mockResolvedValue(null),
    });
    await expect(service.rsvp('u-1', 'ev-1', AttendeeStatus.accepted)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('chama repo.setRsvp quando usuário é attendee', async () => {
    const { service, repo } = makeService({
      findById: jest.fn().mockResolvedValue(makeEvent({ ownerId: 'outro' })),
      findAttendee: jest.fn().mockResolvedValue({ eventId: 'ev-1', userId: 'u-1' }),
      setRsvp: jest
        .fn()
        .mockResolvedValue({ eventId: 'ev-1', userId: 'u-1', status: AttendeeStatus.accepted }),
    });
    const result = await service.rsvp('u-1', 'ev-1', AttendeeStatus.accepted);
    expect(repo.setRsvp).toHaveBeenCalledWith('ev-1', 'u-1', AttendeeStatus.accepted);
    expect(result.status).toBe(AttendeeStatus.accepted);
  });
});

// ── listOccurrences (caminho não-recorrente apenas) ────────────────────────────

describe('EventoService.listOccurrences', () => {
  it('retorna lista vazia quando não há eventos sobrepondo', async () => {
    const { service, repo } = makeService({
      findOverlapping: jest.fn().mockResolvedValue([]),
    });
    const result = await service.listOccurrences('u-1', {
      from: '2026-05-01',
      to: '2026-05-31',
    } as any);
    expect(result).toEqual([]);
    expect(repo.findOverlapping).toHaveBeenCalled();
  });

  it('expande evento simples (não-recorrente) em uma ocorrência', async () => {
    const ev = makeEvent({
      startsAt: new Date('2026-05-15T13:00:00Z'),
      endsAt: new Date('2026-05-15T14:00:00Z'),
    });
    const { service } = makeService({
      findOverlapping: jest.fn().mockResolvedValue([ev]),
    });
    const result = await service.listOccurrences('owner-1', {
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-31T23:59:59Z',
    } as any);
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('ev-1');
    expect(result[0].isOwner).toBe(true);
    expect(result[0].myRsvpStatus).toBeNull();
  });

  it('respeita exception isCancelled (não inclui ocorrência)', async () => {
    const ev = makeEvent({
      startsAt: new Date('2026-05-15T13:00:00Z'),
      endsAt: new Date('2026-05-15T14:00:00Z'),
      exceptions: [
        {
          eventId: 'ev-1',
          originalDate: new Date('2026-05-15T13:00:00Z'),
          isCancelled: true,
          overrideTitle: null,
          overrideDescription: null,
          overrideStartsAt: null,
          overrideEndsAt: null,
          overrideLocation: null,
        } as any,
      ],
    });
    const { service } = makeService({
      findOverlapping: jest.fn().mockResolvedValue([ev]),
    });
    const result = await service.listOccurrences('owner-1', {
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-31T23:59:59Z',
    } as any);
    expect(result).toEqual([]);
  });
});
