import { ReminderMethod } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { NotificacaoService } from '../notificacao/notificacao.service';
import { ReminderDispatcherService } from './reminder-dispatcher.service';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makePrisma(eventFindMany: jest.Mock) {
  return {
    calendarEvent: { findMany: eventFindMany },
    calendarEventReminderSent: {
      create: jest.fn().mockResolvedValue({ id: 'sent-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
}

function makeMailer(): jest.Mocked<MailerService> {
  return {
    sendEventReminderEmail: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailerService>;
}

function makeNotificacao(): jest.Mocked<NotificacaoService> {
  return {
    notify: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<NotificacaoService>;
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    title: 'Daily',
    description: 'desc',
    location: 'Sala 1',
    timezone: 'America/Sao_Paulo',
    rrule: null,
    startsAt: new Date('2026-05-15T13:00:00Z'),
    endsAt: new Date('2026-05-15T13:30:00Z'),
    recurrenceEndAt: null,
    owner: { id: 'owner-1', email: 'owner@x.com' },
    reminders: [{ id: 'r-1', minutesBefore: 30, method: ReminderMethod.email }],
    attendees: [],
    guestEmails: [],
    exceptions: [],
    ...overrides,
  };
}

// Fixa "agora" exatamente no triggerAt (start - 30min = 12:30)
const NOW = new Date('2026-05-15T12:30:00Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

// ── tick ───────────────────────────────────────────────────────────────────────

describe('ReminderDispatcherService.tick', () => {
  it('no-op quando não há eventos', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = makePrisma(findMany);
    const mailer = makeMailer();
    const service = new ReminderDispatcherService(
      prisma,
      mailer,
      makeNotificacao(),
      makeLogger() as any,
    );

    await service.tick();

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEventReminderSent.create).not.toHaveBeenCalled();
    expect(mailer.sendEventReminderEmail).not.toHaveBeenCalled();
  });

  it('envia email para owner quando reminder cai dentro da janela', async () => {
    const ev = makeEvent();
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    const mailer = makeMailer();
    const service = new ReminderDispatcherService(
      prisma,
      mailer,
      makeNotificacao(),
      makeLogger() as any,
    );

    await service.tick();

    expect(prisma.calendarEventReminderSent.create).toHaveBeenCalledWith({
      data: {
        reminderId: 'r-1',
        recipientId: 'owner-1',
        originalDate: ev.startsAt,
      },
    });
    expect(mailer.sendEventReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@x.com',
        title: 'Daily',
        minutesBefore: 30,
        timezone: 'America/Sao_Paulo',
      }),
    );
  });

  it('envia para owner + attendees + guestEmails', async () => {
    const ev = makeEvent({
      attendees: [{ user: { id: 'u-2', email: 'a@x.com' } }],
      guestEmails: [{ email: 'guest@x.com' }],
    });
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    const mailer = makeMailer();
    const service = new ReminderDispatcherService(
      prisma,
      mailer,
      makeNotificacao(),
      makeLogger() as any,
    );

    await service.tick();

    expect(mailer.sendEventReminderEmail).toHaveBeenCalledTimes(3);
    const recipients = mailer.sendEventReminderEmail.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual(['a@x.com', 'guest@x.com', 'owner@x.com']);
  });

  it('NÃO envia quando exception isCancelled para essa ocorrência', async () => {
    const ev = makeEvent({
      exceptions: [
        {
          originalDate: new Date('2026-05-15T13:00:00Z'),
          isCancelled: true,
          overrideTitle: null,
          overrideDescription: null,
          overrideStartsAt: null,
          overrideEndsAt: null,
          overrideLocation: null,
        },
      ],
    });
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    const mailer = makeMailer();
    const service = new ReminderDispatcherService(
      prisma,
      mailer,
      makeNotificacao(),
      makeLogger() as any,
    );

    await service.tick();

    expect(mailer.sendEventReminderEmail).not.toHaveBeenCalled();
  });

  it('NÃO envia quando triggerAt está fora da janela (start muito longe)', async () => {
    // Evento daqui a 2 horas, reminder 30min antes → trigger = 1h30 no futuro, fora dos 2min
    const ev = makeEvent({
      startsAt: new Date(NOW.getTime() + 2 * 3600_000),
      endsAt: new Date(NOW.getTime() + 2 * 3600_000 + 30 * 60_000),
    });
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    const mailer = makeMailer();
    const service = new ReminderDispatcherService(
      prisma,
      mailer,
      makeNotificacao(),
      makeLogger() as any,
    );

    await service.tick();

    expect(prisma.calendarEventReminderSent.create).not.toHaveBeenCalled();
    expect(mailer.sendEventReminderEmail).not.toHaveBeenCalled();
  });

  it('idempotência: P2002 ao criar sent record pula envio sem logar erro', async () => {
    const ev = makeEvent();
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    const p2002 = Object.assign(new Error('unique violation'), { code: 'P2002' });
    prisma.calendarEventReminderSent.create.mockRejectedValue(p2002);
    const mailer = makeMailer();
    const logger = makeLogger();
    const service = new ReminderDispatcherService(prisma, mailer, makeNotificacao(), logger as any);

    await service.tick();

    expect(mailer.sendEventReminderEmail).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('erro inesperado no create do sent record loga e não envia', async () => {
    const ev = makeEvent();
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    prisma.calendarEventReminderSent.create.mockRejectedValue(new Error('boom'));
    const mailer = makeMailer();
    const logger = makeLogger();
    const service = new ReminderDispatcherService(prisma, mailer, makeNotificacao(), logger as any);

    await service.tick();

    expect(mailer.sendEventReminderEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reminderId: 'r-1' }),
      'Falha ao registrar reminder sent',
    );
  });

  it('falha no envio do email faz rollback (deleteMany do sent record)', async () => {
    const ev = makeEvent();
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    const mailer = makeMailer();
    mailer.sendEventReminderEmail.mockRejectedValue(new Error('smtp down'));
    const logger = makeLogger();
    const service = new ReminderDispatcherService(prisma, mailer, makeNotificacao(), logger as any);

    await service.tick();

    expect(prisma.calendarEventReminderSent.deleteMany).toHaveBeenCalledWith({
      where: { reminderId: 'r-1', recipientId: 'owner-1', originalDate: ev.startsAt },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reminderId: 'r-1', to: 'owner@x.com' }),
      'Falha ao enviar email — registro removido para retry',
    );
  });

  it('captura erro global do findMany e loga sem propagar', async () => {
    const prisma = makePrisma(jest.fn().mockRejectedValue(new Error('db down')));
    const mailer = makeMailer();
    const logger = makeLogger();
    const service = new ReminderDispatcherService(prisma, mailer, makeNotificacao(), logger as any);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'db down' }),
      'Falha geral no tick do reminder dispatcher',
    );
  });

  it('usa overrides da exception (overrideTitle, overrideStartsAt) quando presentes', async () => {
    const overrideStart = new Date('2026-05-15T13:00:00Z'); // mantém trigger no NOW
    const ev = makeEvent({
      exceptions: [
        {
          originalDate: new Date('2026-05-15T13:00:00Z'),
          isCancelled: false,
          overrideTitle: 'Título Customizado',
          overrideDescription: null,
          overrideStartsAt: overrideStart,
          overrideEndsAt: null,
          overrideLocation: null,
        },
      ],
    });
    const prisma = makePrisma(jest.fn().mockResolvedValue([ev]));
    const mailer = makeMailer();
    const service = new ReminderDispatcherService(
      prisma,
      mailer,
      makeNotificacao(),
      makeLogger() as any,
    );

    await service.tick();

    expect(mailer.sendEventReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Título Customizado' }),
    );
  });
});
