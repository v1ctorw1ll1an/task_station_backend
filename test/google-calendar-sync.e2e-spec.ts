import * as dotenv from 'dotenv';
import { CalendarSyncWorker } from '../src/google-calendar/calendar-sync.worker';
import { CalendarSyncEnqueuer } from '../src/google-calendar/calendar-sync.enqueuer';
import { GoogleSyncSettingsService } from '../src/google-calendar/google-sync-settings.service';
import { EventoRepository } from '../src/evento/evento.repository';
import { PrismaService } from '../src/prisma/prisma.service';

dotenv.config();

jest.setTimeout(60_000);

const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
const enabledConfig = {
  get: (k: string) =>
    ({
      GOOGLE_CALENDAR_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'http://localhost/cb',
      GOOGLE_TOKEN_ENC_KEY: Buffer.alloc(32).toString('base64'),
    })[k],
};

/**
 * Outbox e consultas da integração contra o **Postgres de verdade**: a reivindicação
 * de jobs é SQL cru (`FOR UPDATE SKIP LOCKED`) e não se testa em mock.
 */
describe('Google Agenda — outbox e agenda (e2e — banco real)', () => {
  let prisma: PrismaService;
  let enqueuer: CalendarSyncEnqueuer;
  let settings: GoogleSyncSettingsService;
  let previousSettings: { syncDirection: 'both' | 'google_to_app' | 'app_to_google' } | null;
  let userId: string;
  const companyIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    settings = new GoogleSyncSettingsService(prisma);
    previousSettings = await prisma.googleCalendarSettings.findUnique({
      where: { id: 'global' },
      select: { syncDirection: true },
    });
    enqueuer = new CalendarSyncEnqueuer(prisma, settings, enabledConfig as never, logger as never);
    const suffix = `${Date.now()}`;
    const user = await prisma.user.create({
      data: {
        email: `e2e-gcal-${suffix}@test.com`,
        passwordHash: 'x',
        name: 'E2E GCal',
        mustResetPassword: false,
      },
    });
    userId = user.id;
    for (const n of [1, 2]) {
      const c = await prisma.company.create({
        data: { legalName: `E2E GCal ${n}`, taxId: `e2e-gcal-${suffix}-${n}`, createdById: userId },
      });
      companyIds.push(c.id);
    }
  });

  afterAll(async () => {
    // Banco compartilhado com o dev: devolve a direção como estava.
    if (previousSettings) {
      await prisma.googleCalendarSettings.update({
        where: { id: 'global' },
        data: { syncDirection: previousSettings.syncDirection },
      });
    } else {
      await prisma.googleCalendarSettings.deleteMany({ where: { id: 'global' } });
    }
    await prisma.calendarSyncJob.deleteMany({ where: { userId } });
    await prisma.googleCalendarConnection.deleteMany({ where: { userId } });
    await prisma.calendarEvent.deleteMany({ where: { ownerId: userId } });
    await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  function worker(runJob: jest.Mock) {
    return new CalendarSyncWorker(
      prisma,
      { runJob } as never,
      {} as never,
      enqueuer,
      {} as never,
      enabledConfig as never,
      logger as never,
    );
  }

  afterEach(async () => {
    await prisma.calendarSyncJob.deleteMany({ where: { userId } });
  });

  it('enfileirar duas vezes o mesmo item gera um único job (dedupe)', async () => {
    await enqueuer.enqueue(userId, 'push_event', 'ev-a');
    await enqueuer.enqueue(userId, 'push_event', 'ev-a');
    expect(await prisma.calendarSyncJob.count({ where: { userId } })).toBe(1);
  });

  it('job concluído é apagado', async () => {
    await enqueuer.enqueue(userId, 'push_task', 't-1');
    const runJob = jest.fn().mockResolvedValue(undefined);
    await worker(runJob).drain();
    expect(runJob).toHaveBeenCalledWith(
      expect.objectContaining({ userId, kind: 'push_task', refId: 't-1', attempts: 0 }),
    );
    expect(await prisma.calendarSyncJob.count({ where: { userId } })).toBe(0);
  });

  it('job que falha ganha backoff e volta para a fila', async () => {
    await enqueuer.enqueue(userId, 'pull_source', 's-1');
    await worker(jest.fn().mockRejectedValue(new Error('boom'))).drain();
    const job = await prisma.calendarSyncJob.findFirstOrThrow({ where: { userId } });
    expect(job.attempts).toBe(1);
    expect(job.lastError).toBe('boom');
    expect(job.lockedUntil).toBeNull();
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('re-enfileirado durante a execução: não é apagado, roda de novo', async () => {
    await enqueuer.enqueue(userId, 'push_event', 'ev-b');
    const runJob = jest.fn().mockImplementation(async () => {
      if (runJob.mock.calls.length === 1) {
        await new Promise((r) => setTimeout(r, 20));
        await enqueuer.enqueue(userId, 'push_event', 'ev-b');
      }
    });
    await worker(runJob).drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(await prisma.calendarSyncJob.count({ where: { userId } })).toBe(0);
  });

  it('job travado por outro worker não é pego', async () => {
    await enqueuer.enqueue(userId, 'full_resync');
    await prisma.calendarSyncJob.updateMany({
      where: { userId },
      data: { lockedUntil: new Date(Date.now() + 60_000) },
    });
    const runJob = jest.fn();
    await worker(runJob).drain();
    expect(runJob).not.toHaveBeenCalledWith(expect.objectContaining({ userId }));
  });

  it('agenda da empresa inclui os eventos pessoais do usuário (Q5), não os de outra empresa', async () => {
    const base = {
      ownerId: userId,
      startsAt: new Date('2026-10-05T13:00:00Z'),
      endsAt: new Date('2026-10-05T14:00:00Z'),
    };
    await prisma.calendarEvent.createMany({
      data: [
        { ...base, title: 'da empresa 1', companyId: companyIds[0] },
        { ...base, title: 'da empresa 2', companyId: companyIds[1] },
        { ...base, title: 'pessoal' },
      ],
    });
    const repo = new EventoRepository(prisma);
    const found = await repo.findOverlapping(
      userId,
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-31T00:00:00Z'),
      { companyId: companyIds[0] },
    );
    expect(found.map((e) => e.title).sort()).toEqual(['da empresa 1', 'pessoal']);
  });

  it('só Google → TaskDY: mutação local não vira job; de volta a "ambos", vira', async () => {
    await prisma.googleCalendarConnection.create({
      data: {
        userId,
        googleAccountId: `e2e-${userId}`,
        googleEmail: 'e2e@gmail.com',
        refreshTokenEnc: 'x',
      },
    });
    const ev = await prisma.calendarEvent.create({
      data: {
        ownerId: userId,
        title: 'direção',
        startsAt: new Date('2026-10-05T13:00:00Z'),
        endsAt: new Date('2026-10-05T14:00:00Z'),
      },
    });

    await settings.setDirection('google_to_app', userId);
    await enqueuer.enqueueForEvent(ev.id);
    expect(await prisma.calendarSyncJob.count({ where: { userId } })).toBe(0);

    await settings.setDirection('both', userId);
    await enqueuer.enqueueForEvent(ev.id);
    expect(
      await prisma.calendarSyncJob.count({ where: { userId, kind: 'push_event', refId: ev.id } }),
    ).toBe(1);
  });
});
