import { ConfigService } from '@nestjs/config';
import { CalendarSyncService } from './calendar-sync.service';
import { PRIVATE_ID_KEY, PRIVATE_KIND_KEY } from './google-calendar-mapper';
import { UserEligibility } from './sync-eligibility.service';
import { SyncDirection } from './sync-rules';

const USER = 'user-1';
const CONN = { id: 'conn-1', userId: USER, status: 'active', refreshTokenEnc: 'x' };
const TASKDY_SOURCE = {
  id: 'src-taskdy',
  connectionId: CONN.id,
  googleCalendarId: 'taskdy@group.calendar.google.com',
  accessRole: 'owner',
  isTaskdyCalendar: true,
  importEnabled: true,
  timeZone: 'America/Sao_Paulo',
  syncToken: 'tok-1',
};
const T0 = new Date('2026-10-01T10:00:00Z');

function makeEvent(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    ownerId: USER,
    companyId: 'co-ok',
    workspaceId: null,
    title: 'Reunião',
    description: null,
    location: null,
    allDay: false,
    startsAt: new Date('2026-10-05T13:00:00Z'),
    endsAt: new Date('2026-10-05T14:00:00Z'),
    timezone: 'America/Sao_Paulo',
    rrule: null,
    externalReadOnly: false,
    deletedAt: null,
    updatedAt: T0,
    exceptions: [],
    attendees: [],
    workspace: null,
    ...over,
  };
}

function setup(
  opts: {
    event?: unknown;
    link?: unknown;
    remoteItems?: unknown[];
    source?: unknown;
    orphan?: unknown;
    direction?: SyncDirection;
  } = {},
) {
  const api = {
    events: {
      insert: jest
        .fn()
        .mockResolvedValue({ data: { id: 'g-new', etag: '"e1"', updated: T0.toISOString() } }),
      update: jest
        .fn()
        .mockResolvedValue({ data: { id: 'g-1', etag: '"e2"', updated: T0.toISOString() } }),
      patch: jest
        .fn()
        .mockResolvedValue({ data: { id: 'g-1', etag: '"e3"', updated: T0.toISOString() } }),
      delete: jest.fn().mockResolvedValue({}),
      get: jest.fn(),
      list: jest
        .fn()
        .mockImplementation((params: { syncToken?: string; privateExtendedProperty?: string[] }) =>
          Promise.resolve({
            data: params.privateExtendedProperty
              ? { items: [] }
              : { items: opts.remoteItems ?? [], nextSyncToken: 'tok-2' },
          }),
        ),
    },
  };

  const prisma = {
    calendarEvent: {
      findUnique: jest.fn().mockResolvedValue(opts.event ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.orphan ?? null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'ev-imported', updatedAt: T0, ...data }),
        ),
      update: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({ id: where.id, updatedAt: T0, externalReadOnly: true }),
        ),
    },
    task: { findUnique: jest.fn().mockResolvedValue(null) },
    googleEventLink: {
      findUnique: jest.fn().mockResolvedValue(opts.link ?? null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'link-new', source: TASKDY_SOURCE, ...data }),
        ),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    googleCalendarSource: {
      findFirst: jest.fn().mockResolvedValue(opts.source ?? TASKDY_SOURCE),
      update: jest.fn().mockResolvedValue({}),
    },
    googleCalendarConnection: { update: jest.fn().mockResolvedValue({}) },
    calendarEventException: { upsert: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };

  const google = { call: <T>(fn: () => Promise<T>) => fn(), calendarFor: () => api };
  const enqueuer = { enqueue: jest.fn(), enqueueForEvent: jest.fn() };
  const connections = { setupCalendars: jest.fn(), markRevoked: jest.fn() };
  const config = { get: (k: string) => (k === 'FRONTEND_URL' ? 'https://app' : undefined) };
  const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };

  // Checagem ao vivo: 'co-ok' elegível; as demais, não.
  const eligibility = {
    isCompanyEligible: jest.fn((id: string) => Promise.resolve(id === 'co-ok')),
  };
  const direction = opts.direction ?? 'both';
  const settings = { getDirection: jest.fn().mockResolvedValue(direction) };
  const service = new CalendarSyncService(
    prisma as never,
    google as never,
    eligibility as never,
    enqueuer as never,
    connections as never,
    settings as never,
    config as unknown as ConfigService,
    logger as never,
  );
  const elig: UserEligibility = {
    companies: [],
    eligibleIds: new Set(['co-ok']),
    personalAllowed: true,
  };
  const ctx = { conn: CONN as never, api: api as never, elig, direction };
  return { service, prisma, api, enqueuer, ctx, eligibility };
}

describe('CalendarSyncService (google-calendar)', () => {
  describe('pushEvent', () => {
    it('evento novo: procura por taskdyId (reatar) e cria no calendário TaskDY', async () => {
      const { service, api, prisma, ctx } = setup({ event: makeEvent() });
      await service.pushEvent(ctx, 'ev-1');

      expect(api.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ privateExtendedProperty: [`${PRIVATE_ID_KEY}=ev-1`] }),
      );
      expect(api.events.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: TASKDY_SOURCE.googleCalendarId,
          sendUpdates: 'none',
        }),
      );
      expect(prisma.googleEventLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            googleEventId: 'g-new',
            calendarEventId: 'ev-1',
            origin: 'taskdy',
            readOnly: false,
            etag: '"e1"',
          }),
        }),
      );
    });

    it('sem mudança local desde o último push: não chama o Google (eco)', async () => {
      const link = {
        id: 'l1',
        googleEventId: 'g-1',
        origin: 'taskdy',
        readOnly: false,
        etag: '"e1"',
        localUpdatedAt: T0,
        sourceId: TASKDY_SOURCE.id,
        source: TASKDY_SOURCE,
      };
      const { service, api, ctx } = setup({ event: makeEvent(), link });
      await service.pushEvent(ctx, 'ev-1');
      expect(api.events.update).not.toHaveBeenCalled();
      expect(api.events.insert).not.toHaveBeenCalled();
    });

    it('mudança local: atualiza com If-Match do último etag', async () => {
      const link = {
        id: 'l1',
        googleEventId: 'g-1',
        origin: 'taskdy',
        readOnly: false,
        etag: '"e1"',
        localUpdatedAt: new Date('2026-09-01T00:00:00Z'),
        sourceId: TASKDY_SOURCE.id,
        source: TASKDY_SOURCE,
      };
      const { service, api, ctx } = setup({ event: makeEvent(), link });
      await service.pushEvent(ctx, 'ev-1');
      expect(api.events.update).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'g-1' }), {
        headers: { 'If-Match': '"e1"' },
      });
    });

    it('empresa não elegível: congela (não mexe no Google)', async () => {
      const { service, api, ctx } = setup({ event: makeEvent({ companyId: 'co-trial' }) });
      await service.pushEvent(ctx, 'ev-1');
      expect(api.events.insert).not.toHaveBeenCalled();
      expect(api.events.delete).not.toHaveBeenCalled();
    });

    it('convidado removido: apaga a cópia dele e o vínculo', async () => {
      const link = {
        id: 'l1',
        googleEventId: 'g-1',
        origin: 'taskdy',
        readOnly: true,
        sourceId: TASKDY_SOURCE.id,
        source: TASKDY_SOURCE,
      };
      const { service, api, prisma, ctx } = setup({
        event: makeEvent({ ownerId: 'outro' }),
        link,
      });
      await service.pushEvent(ctx, 'ev-1');
      expect(api.events.delete).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'g-1' }));
      expect(prisma.googleEventLink.deleteMany).toHaveBeenCalledWith({ where: { id: 'l1' } });
    });

    it('convidado: cópia somente-leitura', async () => {
      const { service, prisma, ctx } = setup({
        event: makeEvent({ ownerId: 'outro', attendees: [{ userId: USER, status: 'accepted' }] }),
      });
      await service.pushEvent(ctx, 'ev-1');
      expect(prisma.googleEventLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ readOnly: true }) }),
      );
    });

    it('importado somente-leitura sem vínculo de origem: não vai para o calendário TaskDY', async () => {
      const { service, api, prisma, ctx } = setup({
        event: makeEvent({ companyId: null, externalReadOnly: true }),
      });
      await service.pushEvent(ctx, 'ev-1');
      expect(api.events.insert).not.toHaveBeenCalled();
      expect(prisma.googleEventLink.upsert).not.toHaveBeenCalled();
    });

    it('importado somente-leitura já copiado no calendário TaskDY: tira a cópia', async () => {
      const link = {
        id: 'l1',
        googleEventId: 'g-copy',
        origin: 'taskdy',
        readOnly: true,
        sourceId: TASKDY_SOURCE.id,
        source: TASKDY_SOURCE,
      };
      const { service, api, prisma, ctx } = setup({
        event: makeEvent({ companyId: null, externalReadOnly: true }),
        link,
      });
      await service.pushEvent(ctx, 'ev-1', { force: true });
      expect(api.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'g-copy' }),
      );
      expect(prisma.googleEventLink.deleteMany).toHaveBeenCalledWith({ where: { id: 'l1' } });
      expect(api.events.update).not.toHaveBeenCalled();
    });
  });

  describe('pullSource', () => {
    const baseLink = {
      id: 'l1',
      kind: 'event',
      googleEventId: 'g-1',
      calendarEventId: 'ev-1',
      origin: 'taskdy',
      readOnly: false,
      etag: '"e1"',
      localUpdatedAt: T0,
      sourceId: TASKDY_SOURCE.id,
      source: TASKDY_SOURCE,
    };
    const remote = (over: Record<string, unknown> = {}) => ({
      id: 'g-1',
      etag: '"e9"',
      updated: '2026-10-02T00:00:00Z',
      summary: 'Reunião editada no Google',
      start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: 'America/Sao_Paulo' },
      ...over,
    });

    it('usa o syncToken e grava o próximo', async () => {
      const { service, api, prisma, ctx } = setup();
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(api.events.list).toHaveBeenCalledWith(expect.objectContaining({ syncToken: 'tok-1' }));
      expect(prisma.googleCalendarSource.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ syncToken: 'tok-2' }) }),
      );
    });

    it('etag igual ao do link = eco: não altera nada', async () => {
      const { service, prisma, api, ctx } = setup({
        event: makeEvent(),
        link: baseLink,
        remoteItems: [remote({ etag: '"e1"' })],
      });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
      expect(api.events.update).not.toHaveBeenCalled();
    });

    it('edição no Google (só lá mudou): aplica no TaskDY e avisa os convidados', async () => {
      const { service, prisma, enqueuer, ctx } = setup({
        event: makeEvent(),
        link: baseLink,
        remoteItems: [remote()],
      });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ev-1' },
          data: expect.objectContaining({ title: 'Reunião editada no Google' }),
        }),
      );
      expect(enqueuer.enqueueForEvent).toHaveBeenCalledWith('ev-1');
    });

    it('edição do convidado no Google: reverte (reenvia o local sem If-Match)', async () => {
      const { service, prisma, api, ctx } = setup({
        event: makeEvent({ ownerId: 'outro', attendees: [{ userId: USER, status: 'accepted' }] }),
        link: { ...baseLink, readOnly: true },
        remoteItems: [remote()],
      });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
      expect(api.events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'g-1',
          requestBody: expect.objectContaining({ summary: 'Reunião' }),
        }),
        { headers: undefined },
      );
    });

    it('empresa congelada: edição do Google é ignorada', async () => {
      const { service, prisma, api, ctx } = setup({
        event: makeEvent({ companyId: 'co-trial' }),
        link: baseLink,
        remoteItems: [remote()],
      });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
      expect(api.events.update).not.toHaveBeenCalled();
    });

    it('evento criado no Google: vira evento pessoal, com vínculo de origem Google', async () => {
      const { service, prisma, api, ctx } = setup({ remoteItems: [remote({ id: 'g-new' })] });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      const created = prisma.calendarEvent.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ ownerId: USER, title: 'Reunião editada no Google' });
      expect(created.companyId).toBeUndefined();
      // Marca o taskdyId no Google para a reconexão não duplicar.
      expect(api.events.patch).toHaveBeenCalled();
      expect(prisma.googleEventLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ origin: 'google', calendarEventId: 'ev-imported' }),
        }),
      );
    });

    it('calendário só-leitura: evento órfão igual é reatado e colorido, não duplicado', async () => {
      const holidays = {
        ...TASKDY_SOURCE,
        id: 'src-feriados',
        googleCalendarId: 'pt-br.brazilian#holiday@group.v.calendar.google.com',
        accessRole: 'reader',
        isTaskdyCalendar: false,
        color: '#0b8043',
      };
      const { service, prisma, api, ctx } = setup({
        source: holidays,
        orphan: { id: 'ev-orfao' },
        remoteItems: [remote({ id: 'g-feriado' })],
      });
      await service.pullSource(ctx, holidays.id);
      expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
      expect(prisma.calendarEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ev-orfao' },
          data: expect.objectContaining({ color: '#0b8043', externalReadOnly: true }),
        }),
      );
      expect(api.events.patch).not.toHaveBeenCalled(); // só-leitura: não marca taskdyId
      expect(prisma.googleEventLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            origin: 'google',
            sourceId: 'src-feriados',
            calendarEventId: 'ev-orfao',
          }),
        }),
      );
    });

    it('reatar: evento do Google com taskdyId conhecido é vinculado, não duplicado', async () => {
      const { service, prisma, ctx } = setup({
        event: makeEvent({ updatedAt: new Date('2026-10-03T00:00:00Z') }),
        remoteItems: [
          remote({
            id: 'g-old',
            extendedProperties: {
              private: { [PRIVATE_ID_KEY]: 'ev-1', [PRIVATE_KIND_KEY]: 'event' },
            },
          }),
        ],
      });
      // findUnique do link: nenhum por googleEventId nem por item.
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
      expect(prisma.googleEventLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            googleEventId: 'g-old',
            calendarEventId: 'ev-1',
            etag: null,
          }),
        }),
      );
    });

    it('sem empresa elegível: evento novo do Google não é importado', async () => {
      const { service, prisma, ctx } = setup({ remoteItems: [remote({ id: 'g-new' })] });
      ctx.elig = { companies: [], eligibleIds: new Set(), personalAllowed: false };
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('regras de permissão e congelamento (auditoria)', () => {
    const remoteBase = {
      etag: '"e9"',
      updated: '2026-10-09T00:00:00Z',
      summary: 'Sequestrado',
      start: { dateTime: '2026-10-05T10:00:00-03:00' },
      end: { dateTime: '2026-10-05T11:00:00-03:00' },
    };

    it('convidado forjando taskdyOrigin=google não ganha edição do evento alheio', async () => {
      const { service, prisma, api, ctx } = setup({
        event: makeEvent({ ownerId: 'dono', attendees: [{ userId: USER, status: 'accepted' }] }),
        remoteItems: [
          {
            ...remoteBase,
            id: 'g-forjado',
            extendedProperties: {
              private: {
                [PRIVATE_ID_KEY]: 'ev-1',
                [PRIVATE_KIND_KEY]: 'event',
                taskdyOrigin: 'google',
              },
            },
          },
        ],
      });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      // Vínculo criado como origem TaskDY (o marcador foi ignorado)...
      expect(prisma.googleEventLink.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ origin: 'taskdy' }) }),
      );
      // ...e a edição dele não chega ao evento do dono.
      expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
      // Revertido no Google: a versão local do dono é reenviada.
      const writes = [...api.events.update.mock.calls, ...api.events.insert.mock.calls];
      expect(writes.some(([p]) => p.requestBody?.summary === 'Reunião')).toBe(true);
    });

    it('convidado que recusou não é reatado (a cópia forjada é apagada)', async () => {
      const { service, prisma, api, ctx } = setup({
        event: makeEvent({ ownerId: 'dono', attendees: [{ userId: USER, status: 'declined' }] }),
        remoteItems: [
          {
            ...remoteBase,
            id: 'g-forjado',
            extendedProperties: {
              private: { [PRIVATE_ID_KEY]: 'ev-1', [PRIVATE_KIND_KEY]: 'event' },
            },
          },
        ],
      });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.googleEventLink.create).not.toHaveBeenCalled();
      expect(api.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'g-forjado' }),
      );
    });

    it('exclusão no Google com a empresa congelada: não apaga no TaskDY', async () => {
      const { service, prisma, ctx } = setup({
        event: makeEvent({ companyId: 'co-trial' }),
        link: {
          id: 'l1',
          kind: 'event',
          googleEventId: 'g-1',
          calendarEventId: 'ev-1',
          origin: 'taskdy',
          readOnly: false,
          etag: '"e1"',
          localUpdatedAt: T0,
          sourceId: TASKDY_SOURCE.id,
          source: TASKDY_SOURCE,
        },
        remoteItems: [{ id: 'g-1', status: 'cancelled' }],
      });
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
    });

    it('empresa suspensa no meio do job: a checagem ao vivo barra a escrita', async () => {
      const { service, prisma, ctx, eligibility } = setup({
        event: makeEvent(),
        link: {
          id: 'l1',
          kind: 'event',
          googleEventId: 'g-1',
          calendarEventId: 'ev-1',
          origin: 'taskdy',
          readOnly: false,
          etag: '"e1"',
          localUpdatedAt: T0,
          sourceId: TASKDY_SOURCE.id,
          source: TASKDY_SOURCE,
        },
        remoteItems: [{ id: 'g-1', status: 'cancelled' }],
      });
      // Snapshot do contexto diz elegível; o billing agora diz que não.
      eligibility.isCompanyEligible.mockResolvedValue(false);
      await service.pullSource(ctx, TASKDY_SOURCE.id);
      expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
    });

    it('tarefa de empresa congelada não vai para o Google', async () => {
      const { service, prisma, api, ctx } = setup();
      prisma.task.findUnique.mockResolvedValue({
        id: 't-1',
        title: 'Prazo',
        deletedAt: null,
        startDate: null,
        dueDate: new Date('2026-10-10T20:00:00Z'),
        allDay: false,
        timezone: 'America/Sao_Paulo',
        updatedAt: T0,
        column: { isDone: false },
        project: {
          id: 'p',
          workspaceId: 'w',
          deletedAt: null,
          workspace: { companyId: 'co-trial', deletedAt: null },
        },
        taskAssignees: [{ userId: USER }],
      });
      await service.pushTask(ctx, 't-1');
      expect(api.events.insert).not.toHaveBeenCalled();
      expect(api.events.update).not.toHaveBeenCalled();
    });
  });

  describe('direção da sincronização (controle do superusuário)', () => {
    const taskdyLink = {
      id: 'l1',
      kind: 'event',
      googleEventId: 'g-1',
      calendarEventId: 'ev-1',
      origin: 'taskdy',
      readOnly: false,
      etag: '"e1"',
      localUpdatedAt: new Date('2026-09-01T00:00:00Z'),
      sourceId: TASKDY_SOURCE.id,
      source: TASKDY_SOURCE,
    };
    const IMPORTED_SOURCE = {
      ...TASKDY_SOURCE,
      id: 'src-pessoal',
      googleCalendarId: 'pessoal@gmail.com',
      isTaskdyCalendar: false,
    };
    const googleLink = {
      ...taskdyLink,
      origin: 'google',
      sourceId: IMPORTED_SOURCE.id,
      source: IMPORTED_SOURCE,
    };
    const remote = (over: Record<string, unknown> = {}) => ({
      id: 'g-1',
      etag: '"e9"',
      updated: '2026-10-02T00:00:00Z',
      summary: 'Editado no Google',
      start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: 'America/Sao_Paulo' },
      ...over,
    });
    const task = {
      id: 't-1',
      title: 'Prazo',
      deletedAt: null,
      startDate: null,
      dueDate: new Date('2026-10-10T20:00:00Z'),
      allDay: false,
      timezone: 'America/Sao_Paulo',
      updatedAt: T0,
      column: { isDone: false },
      project: {
        id: 'p',
        workspaceId: 'w',
        deletedAt: null,
        workspace: { companyId: 'co-ok', deletedAt: null },
      },
      taskAssignees: [{ userId: USER }],
    };

    describe('só Google → TaskDY', () => {
      it('evento novo do TaskDY não é enviado ao Google', async () => {
        const { service, api, prisma, ctx } = setup({
          event: makeEvent(),
          direction: 'google_to_app',
        });
        await service.pushEvent(ctx, 'ev-1');
        expect(api.events.list).not.toHaveBeenCalled();
        expect(api.events.insert).not.toHaveBeenCalled();
        expect(prisma.googleEventLink.upsert).not.toHaveBeenCalled();
      });

      it('evento excluído no TaskDY não apaga a cópia do Google', async () => {
        const { service, api, ctx } = setup({
          event: makeEvent({ deletedAt: T0 }),
          link: taskdyLink,
          direction: 'google_to_app',
        });
        await service.pushEvent(ctx, 'ev-1');
        expect(api.events.delete).not.toHaveBeenCalled();
      });

      it('tarefa com prazo não vai para o Google', async () => {
        const { service, api, prisma, ctx } = setup({ direction: 'google_to_app' });
        prisma.task.findUnique.mockResolvedValue(task);
        await service.pushTask(ctx, 't-1');
        expect(api.events.insert).not.toHaveBeenCalled();
        expect(api.events.update).not.toHaveBeenCalled();
      });

      it('evento criado no Google continua sendo importado', async () => {
        const { service, prisma, ctx } = setup({
          remoteItems: [remote({ id: 'g-new' })],
          direction: 'google_to_app',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ ownerId: USER, title: 'Editado no Google' }),
          }),
        );
      });

      it('conflito com o TaskDY editado por último: o Google vence', async () => {
        const { service, prisma, api, ctx } = setup({
          event: makeEvent({ updatedAt: new Date('2026-10-03T00:00:00Z') }),
          link: taskdyLink,
          remoteItems: [remote()],
          direction: 'google_to_app',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ title: 'Editado no Google' }),
          }),
        );
        expect(api.events.update).not.toHaveBeenCalled();
      });

      it('edição de convidado no Google: não aplica e não reverte', async () => {
        const { service, prisma, api, ctx } = setup({
          event: makeEvent({ ownerId: 'outro', attendees: [{ userId: USER, status: 'accepted' }] }),
          link: { ...taskdyLink, readOnly: true },
          remoteItems: [remote()],
          direction: 'google_to_app',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
        expect(api.events.update).not.toHaveBeenCalled();
      });

      it('cópia somente-leitura apagada no Google: solta o vínculo sem recriar', async () => {
        const { service, prisma, api, ctx } = setup({
          event: makeEvent({ ownerId: 'outro', attendees: [{ userId: USER, status: 'accepted' }] }),
          link: { ...taskdyLink, readOnly: true },
          remoteItems: [{ id: 'g-1', status: 'cancelled' }],
          direction: 'google_to_app',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.googleEventLink.delete).toHaveBeenCalledWith({ where: { id: 'l1' } });
        expect(api.events.insert).not.toHaveBeenCalled();
        expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
      });

      it('tarefa editada no Google não é desfeita', async () => {
        const { service, prisma, api, ctx } = setup({
          link: {
            ...taskdyLink,
            kind: 'task',
            calendarEventId: null,
            taskId: 't-1',
            readOnly: true,
          },
          remoteItems: [remote()],
          direction: 'google_to_app',
        });
        prisma.task.findUnique.mockResolvedValue(task);
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(api.events.update).not.toHaveBeenCalled();
        expect(api.events.insert).not.toHaveBeenCalled();
      });
    });

    describe('só TaskDY → Google', () => {
      it('evento do TaskDY continua sendo enviado', async () => {
        const { service, api, ctx } = setup({ event: makeEvent(), direction: 'app_to_google' });
        await service.pushEvent(ctx, 'ev-1');
        expect(api.events.insert).toHaveBeenCalled();
      });

      it('evento criado no Google não é importado', async () => {
        const { service, prisma, api, ctx } = setup({
          remoteItems: [remote({ id: 'g-new' })],
          direction: 'app_to_google',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
        expect(api.events.patch).not.toHaveBeenCalled();
      });

      it('calendário importado nem é lido', async () => {
        const { service, api, prisma, ctx } = setup({
          source: IMPORTED_SOURCE,
          direction: 'app_to_google',
        });
        expect(await service.pullSource(ctx, IMPORTED_SOURCE.id)).toBeNull();
        expect(api.events.list).not.toHaveBeenCalled();
        expect(prisma.googleCalendarSource.update).not.toHaveBeenCalled();
      });

      it('calendário TaskDY segue sendo lido (para desfazer edições)', async () => {
        const { service, api, ctx } = setup({ direction: 'app_to_google' });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(api.events.list).toHaveBeenCalledWith(
          expect.objectContaining({ syncToken: 'tok-1' }),
        );
      });

      it('dono editou a cópia no Google: reverte para a versão do TaskDY', async () => {
        const { service, prisma, api, ctx } = setup({
          event: makeEvent(),
          link: { ...taskdyLink, localUpdatedAt: T0 },
          remoteItems: [remote()],
          direction: 'app_to_google',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
        expect(api.events.update).toHaveBeenCalledWith(
          expect.objectContaining({
            eventId: 'g-1',
            requestBody: expect.objectContaining({ summary: 'Reunião' }),
          }),
          { headers: undefined },
        );
      });

      it('dono apagou a cópia no Google: recria, não apaga no TaskDY', async () => {
        const { service, prisma, api, ctx } = setup({
          event: makeEvent(),
          link: { ...taskdyLink, localUpdatedAt: T0 },
          remoteItems: [{ id: 'g-1', status: 'cancelled' }],
          direction: 'app_to_google',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
        expect(api.events.insert).toHaveBeenCalled();
      });

      it('evento nativo do Google editado lá: nem aplica nem reverte', async () => {
        const { service, prisma, api, ctx } = setup({
          event: makeEvent(),
          link: { ...googleLink, localUpdatedAt: T0 },
          remoteItems: [remote()],
          direction: 'app_to_google',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
        expect(api.events.update).not.toHaveBeenCalled();
        expect(api.events.patch).not.toHaveBeenCalled();
      });

      it('evento nativo do Google apagado lá: só solta o vínculo', async () => {
        const { service, prisma, ctx } = setup({
          event: makeEvent(),
          link: googleLink,
          remoteItems: [{ id: 'g-1', status: 'cancelled' }],
          direction: 'app_to_google',
        });
        await service.pullSource(ctx, TASKDY_SOURCE.id);
        expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
        expect(prisma.googleEventLink.delete).toHaveBeenCalledWith({ where: { id: 'l1' } });
      });
    });

    it('runJob lê a direção da configuração global', async () => {
      const { service, api, prisma, eligibility } = setup({
        event: makeEvent(),
        direction: 'google_to_app',
      });
      Object.assign(prisma.googleCalendarConnection, {
        findUnique: jest.fn().mockResolvedValue(CONN),
      });
      Object.assign(eligibility, {
        forUser: jest.fn().mockResolvedValue({
          companies: [],
          eligibleIds: new Set(['co-ok']),
          personalAllowed: true,
        }),
      });
      await service.runJob({ userId: USER, kind: 'push_event', refId: 'ev-1' });
      expect(api.events.insert).not.toHaveBeenCalled();
    });
  });
});
