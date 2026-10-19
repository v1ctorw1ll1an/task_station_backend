import {
  eventToGoogle,
  googleCalendarColor,
  googleEventColor,
  googleInstanceToException,
  googleToEventData,
  instanceSuffix,
  LocalEvent,
  PRIVATE_ID_KEY,
  PRIVATE_KIND_KEY,
  taskToGoogle,
} from './google-calendar-mapper';

const TZ = 'America/Sao_Paulo'; // UTC-3, sem horário de verão

function baseEvent(over: Partial<LocalEvent> = {}): LocalEvent {
  return {
    id: 'ev-1',
    title: 'Reunião',
    description: 'Pauta',
    location: 'Sala 1',
    allDay: false,
    startsAt: new Date('2026-10-05T13:00:00Z'), // 10:00 BRT
    endsAt: new Date('2026-10-05T14:00:00Z'),
    timezone: TZ,
    rrule: null,
    companyId: 'co-1',
    exceptions: [],
    ...over,
  };
}

describe('google-calendar-mapper', () => {
  describe('eventToGoogle', () => {
    it('evento com horário: dateTime + timezone, privado quando é de empresa, id privado', () => {
      const { master, overrides } = eventToGoogle(baseEvent());
      expect(master.start).toEqual({ dateTime: '2026-10-05T13:00:00.000Z', timeZone: TZ });
      expect(master.end).toEqual({ dateTime: '2026-10-05T14:00:00.000Z', timeZone: TZ });
      expect(master.visibility).toBe('private');
      expect(master.reminders).toEqual({ useDefault: true });
      expect(master.recurrence).toEqual([]);
      expect(master.extendedProperties?.private).toEqual({
        [PRIVATE_ID_KEY]: 'ev-1',
        [PRIVATE_KIND_KEY]: 'event',
      });
      expect(overrides).toEqual([]);
    });

    it('evento pessoal usa a visibilidade padrão do calendário', () => {
      expect(eventToGoogle(baseEvent({ companyId: null })).master.visibility).toBe('default');
    });

    it('dia inteiro: fim exclusivo no Google (último dia + 1)', () => {
      const { master } = eventToGoogle(
        baseEvent({
          allDay: true,
          startsAt: new Date('2026-10-05T03:00:00Z'), // 00:00 BRT
          endsAt: new Date('2026-10-07T03:00:00Z'),
        }),
      );
      expect(master.start).toEqual({ date: '2026-10-05' });
      expect(master.end).toEqual({ date: '2026-10-08' });
    });

    it('RRULE + ocorrência cancelada → RRULE + EXDATE no horário local', () => {
      const { master } = eventToGoogle(
        baseEvent({
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          exceptions: [
            {
              originalDate: new Date('2026-10-12T13:00:00Z'),
              isCancelled: true,
              overrideTitle: null,
              overrideDescription: null,
              overrideStartsAt: null,
              overrideEndsAt: null,
              overrideLocation: null,
            },
          ],
        }),
      );
      expect(master.recurrence).toEqual([
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        `EXDATE;TZID=${TZ}:20261012T100000`,
      ]);
    });

    it('UNTIL em relógio de parede vira instante UTC real', () => {
      const { master } = eventToGoogle(baseEvent({ rrule: 'FREQ=DAILY;UNTIL=20261231T100000Z' }));
      expect(master.recurrence).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261231T130000Z']);
    });

    it('UNTIL só com data: fim do dia local; em dia inteiro fica só a data', () => {
      expect(
        eventToGoogle(baseEvent({ rrule: 'FREQ=DAILY;UNTIL=20261231' })).master.recurrence,
      ).toEqual(['RRULE:FREQ=DAILY;UNTIL=20270101T025959Z']);
      expect(
        eventToGoogle(
          baseEvent({
            allDay: true,
            startsAt: new Date('2026-10-05T03:00:00Z'),
            endsAt: new Date('2026-10-05T03:00:00Z'),
            rrule: 'FREQ=DAILY;UNTIL=20261231T000000Z',
          }),
        ).master.recurrence,
      ).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261231']);
    });

    it('RDATES= → RDATE (sem repetir o início)', () => {
      const { master } = eventToGoogle(
        baseEvent({ rrule: 'RDATES=2026-10-05,2026-10-20,2026-11-03' }),
      );
      expect(master.recurrence).toEqual([`RDATE;TZID=${TZ}:20261020T100000,20261103T100000`]);
    });

    it('RDATES= sem a data de início → EXDATE no início (âncora não é ocorrência)', () => {
      const { master } = eventToGoogle(baseEvent({ rrule: 'RDATES=2026-10-20' }));
      expect(master.recurrence).toEqual([
        `RDATE;TZID=${TZ}:20261020T100000`,
        `EXDATE;TZID=${TZ}:20261005T100000`,
      ]);
    });

    it('RDATES= em dia inteiro usa VALUE=DATE', () => {
      const { master } = eventToGoogle(
        baseEvent({
          allDay: true,
          startsAt: new Date('2026-10-05T03:00:00Z'),
          endsAt: new Date('2026-10-05T03:00:00Z'),
          rrule: 'RDATES=2026-10-05,2026-10-09',
        }),
      );
      expect(master.recurrence).toEqual(['RDATE;VALUE=DATE:20261009']);
    });

    it('exceção com override → instância sobrescrita', () => {
      const { overrides } = eventToGoogle(
        baseEvent({
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          exceptions: [
            {
              originalDate: new Date('2026-10-12T13:00:00Z'),
              isCancelled: false,
              overrideTitle: 'Reunião (remarcada)',
              overrideDescription: null,
              overrideStartsAt: new Date('2026-10-12T17:00:00Z'),
              overrideEndsAt: null,
              overrideLocation: null,
            },
          ],
        }),
      );
      expect(overrides).toHaveLength(1);
      expect(overrides[0].instanceSuffix).toBe('20261012T130000Z');
      expect(overrides[0].body.summary).toBe('Reunião (remarcada)');
      expect(overrides[0].body.start).toEqual({
        dateTime: '2026-10-12T17:00:00.000Z',
        timeZone: TZ,
      });
      // Duração da série preservada
      expect(overrides[0].body.end).toEqual({ dateTime: '2026-10-12T18:00:00.000Z', timeZone: TZ });
      expect(overrides[0].body.originalStartTime).toEqual({
        dateTime: '2026-10-12T13:00:00.000Z',
        timeZone: TZ,
      });
    });
  });

  describe('googleToEventData', () => {
    it('evento com horário', () => {
      const m = googleToEventData({
        summary: 'Dentista',
        start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: TZ },
        end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: TZ },
      });
      expect(m?.mappable).toBe(true);
      expect(m?.data).toMatchObject({
        title: 'Dentista',
        allDay: false,
        startsAt: new Date('2026-10-05T13:00:00Z'),
        endsAt: new Date('2026-10-05T14:00:00Z'),
        timezone: TZ,
        rrule: null,
      });
    });

    it('dia inteiro: fim exclusivo → último dia inclusivo, meia-noite local', () => {
      const m = googleToEventData(
        { start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
        TZ,
      );
      expect(m?.data.allDay).toBe(true);
      expect(m?.data.startsAt).toEqual(new Date('2026-10-05T03:00:00Z'));
      expect(m?.data.endsAt).toEqual(new Date('2026-10-05T03:00:00Z'));
      expect(m?.data.title).toBe('(sem título)');
    });

    it('usa o fuso do calendário quando o evento não traz', () => {
      const m = googleToEventData(
        { start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
        'UTC',
      );
      expect(m?.data.timezone).toBe('UTC');
      expect(m?.data.startsAt).toEqual(new Date('2026-10-05T00:00:00Z'));
    });

    it('RRULE com FREQ fora de ordem é normalizada; EXDATE vira ocorrência cancelada', () => {
      const m = googleToEventData({
        start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: TZ },
        end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: TZ },
        recurrence: ['RRULE:BYDAY=MO;FREQ=WEEKLY', `EXDATE;TZID=${TZ}:20261012T100000`],
      });
      expect(m?.mappable).toBe(true);
      expect(m?.data.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
      expect(m?.data.cancelledDates).toEqual([new Date('2026-10-12T13:00:00Z')]);
    });

    it('UNTIL UTC do Google volta para relógio de parede', () => {
      const m = googleToEventData({
        start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: TZ },
        end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: TZ },
        recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261231T130000Z'],
      });
      expect(m?.data.rrule).toBe('FREQ=DAILY;UNTIL=20261231T100000Z');
    });

    it('RDATE no mesmo horário → RDATES= (EXDATE tira a data da lista)', () => {
      const m = googleToEventData({
        start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: TZ },
        end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: TZ },
        recurrence: [
          `RDATE;TZID=${TZ}:20261020T100000,20261103T100000`,
          `EXDATE;TZID=${TZ}:20261020T100000`,
        ],
      });
      expect(m?.mappable).toBe(true);
      expect(m?.data.rrule).toBe('RDATES=2026-10-05,2026-11-03');
      expect(m?.data.cancelledDates).toEqual([]);
    });

    it('RDATE em horário diferente → somente-leitura', () => {
      const m = googleToEventData({
        start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: TZ },
        end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: TZ },
        recurrence: [`RDATE;TZID=${TZ}:20261020T150000`],
      });
      expect(m?.mappable).toBe(false);
    });

    it.each([
      [['RRULE:FREQ=WEEKLY', 'EXRULE:FREQ=MONTHLY']],
      [['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=MONTHLY']],
      [['RRULE:FREQ=WEEKLY', `RDATE;TZID=${TZ}:20261020T100000`]],
    ])('recorrência sem tradução (%j) → somente-leitura com aproximação', (recurrence) => {
      const m = googleToEventData({
        start: { dateTime: '2026-10-05T10:00:00-03:00', timeZone: TZ },
        end: { dateTime: '2026-10-05T11:00:00-03:00', timeZone: TZ },
        recurrence,
      });
      expect(m?.mappable).toBe(false);
      expect(m?.data.rrule).toBe('FREQ=WEEKLY');
    });

    it('FREQ=HOURLY não é suportada → somente-leitura sem regra', () => {
      const m = googleToEventData({
        start: { dateTime: '2026-10-05T10:00:00-03:00' },
        end: { dateTime: '2026-10-05T11:00:00-03:00' },
        recurrence: ['RRULE:FREQ=HOURLY'],
      });
      expect(m?.mappable).toBe(false);
      expect(m?.data.rrule).toBeNull();
    });

    it('sem horário (cancelado sem corpo) → null', () => {
      expect(googleToEventData({ status: 'cancelled' })).toBeNull();
    });

    it('ida e volta preserva a série (RRULE, UNTIL, EXDATE)', () => {
      const ev = baseEvent({
        rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T100000Z',
        exceptions: [
          {
            originalDate: new Date('2026-10-12T13:00:00Z'),
            isCancelled: true,
            overrideTitle: null,
            overrideDescription: null,
            overrideStartsAt: null,
            overrideEndsAt: null,
            overrideLocation: null,
          },
        ],
      });
      const back = googleToEventData(eventToGoogle(ev).master);
      expect(back?.mappable).toBe(true);
      expect(back?.data).toMatchObject({
        title: ev.title,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        rrule: ev.rrule,
        cancelledDates: [new Date('2026-10-12T13:00:00Z')],
      });
    });

    it('ida e volta de RDATES= sem a data de início', () => {
      const ev = baseEvent({ rrule: 'RDATES=2026-10-20,2026-11-03' });
      const back = googleToEventData(eventToGoogle(ev).master);
      expect(back?.data.rrule).toBe('RDATES=2026-10-20,2026-11-03');
    });
  });

  describe('googleInstanceToException', () => {
    const master = { allDay: false, timezone: TZ };

    it('instância cancelada', () => {
      expect(
        googleInstanceToException(
          {
            status: 'cancelled',
            recurringEventId: 'abc',
            originalStartTime: { dateTime: '2026-10-12T10:00:00-03:00' },
          },
          master,
        ),
      ).toMatchObject({ originalDate: new Date('2026-10-12T13:00:00Z'), isCancelled: true });
    });

    it('instância alterada', () => {
      expect(
        googleInstanceToException(
          {
            recurringEventId: 'abc',
            summary: 'Outra',
            originalStartTime: { dateTime: '2026-10-12T10:00:00-03:00' },
            start: { dateTime: '2026-10-12T14:00:00-03:00' },
            end: { dateTime: '2026-10-12T15:00:00-03:00' },
          },
          master,
        ),
      ).toMatchObject({
        isCancelled: false,
        overrideTitle: 'Outra',
        overrideStartsAt: new Date('2026-10-12T17:00:00Z'),
        overrideEndsAt: new Date('2026-10-12T18:00:00Z'),
      });
    });

    it('dia inteiro: originalStartTime.date → meia-noite local', () => {
      const r = googleInstanceToException(
        { status: 'cancelled', originalStartTime: { date: '2026-10-12' } },
        { allDay: true, timezone: TZ },
      );
      expect(r?.originalDate).toEqual(new Date('2026-10-12T03:00:00Z'));
    });
  });

  describe('instanceSuffix', () => {
    it('com horário usa UTC compacto; dia inteiro usa a data local', () => {
      expect(instanceSuffix(new Date('2026-10-12T13:00:00Z'), false, TZ)).toBe('20261012T130000Z');
      expect(instanceSuffix(new Date('2026-10-12T03:00:00Z'), true, TZ)).toBe('20261012');
    });
  });

  describe('taskToGoogle', () => {
    const base = {
      id: 'task-1',
      title: 'Entregar relatório',
      startDate: null,
      dueDate: new Date('2026-10-10T20:00:00Z'), // 17:00 BRT
      allDay: false,
      timezone: TZ,
      isDone: false,
      url: 'https://taskdy.com.br/workspace/w/projetos/p?task=task-1',
    };

    it('sem início e com hora: 30 min terminando no prazo; transparente; link', () => {
      const g = taskToGoogle(base);
      expect(g.start).toEqual({ dateTime: '2026-10-10T19:30:00.000Z', timeZone: TZ });
      expect(g.end).toEqual({ dateTime: '2026-10-10T20:00:00.000Z', timeZone: TZ });
      expect(g.transparency).toBe('transparent');
      expect(g.description).toContain(base.url);
      expect(g.source?.url).toBe(base.url);
      expect(g.extendedProperties?.private).toEqual({
        [PRIVATE_ID_KEY]: 'task-1',
        [PRIVATE_KIND_KEY]: 'task',
      });
    });

    it('com início: startDate → dueDate', () => {
      const g = taskToGoogle({ ...base, startDate: new Date('2026-10-10T12:00:00Z') });
      expect(g.start?.dateTime).toBe('2026-10-10T12:00:00.000Z');
      expect(g.end?.dateTime).toBe('2026-10-10T20:00:00.000Z');
    });

    it('dia inteiro: do dia de início ao dia do prazo', () => {
      const g = taskToGoogle({
        ...base,
        allDay: true,
        startDate: new Date('2026-10-08T03:00:00Z'),
        dueDate: new Date('2026-10-10T03:00:00Z'),
      });
      expect(g.start).toEqual({ date: '2026-10-08' });
      expect(g.end).toEqual({ date: '2026-10-11' });
    });

    it('hora 00:00 = "sem horário" → dia inteiro no dia do prazo', () => {
      const g = taskToGoogle({ ...base, dueDate: new Date('2026-10-10T03:00:00Z') });
      expect(g.start).toEqual({ date: '2026-10-10' });
      expect(g.end).toEqual({ date: '2026-10-11' });
    });

    it('concluída ganha "✓ " no título', () => {
      expect(taskToGoogle({ ...base, isDone: true }).summary).toBe('✓ Entregar relatório');
      expect(taskToGoogle(base).summary).toBe('Entregar relatório');
    });
  });
});

describe('cores do Google', () => {
  it('traduz a cor antiga do calendário para a da interface atual', () => {
    expect(googleCalendarColor('#16A765')).toBe('#0b8043');
  });

  it('cor personalizada do calendário passa direto; inválida vira null', () => {
    expect(googleCalendarColor('#123abc')).toBe('#123abc');
    expect(googleCalendarColor('azul')).toBeNull();
    expect(googleCalendarColor(undefined)).toBeNull();
  });

  it('colorId do evento vence a cor do calendário', () => {
    expect(googleEventColor({ colorId: '11' }, '#0b8043')).toBe('#d50000');
  });

  it('sem colorId (ou desconhecido) usa a cor do calendário', () => {
    expect(googleEventColor({}, '#0b8043')).toBe('#0b8043');
    expect(googleEventColor({ colorId: '99' }, null)).toBeNull();
  });
});
