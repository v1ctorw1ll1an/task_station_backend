import type { calendar_v3 } from '@googleapis/calendar';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { rrulestr } from 'rrule';

export type GoogleEvent = calendar_v3.Schema$Event;

/**
 * Chaves em `extendedProperties.private` que marcam um evento do Google como item do
 * TaskDY — é por elas que a reconexão reata sem duplicar (Q19).
 */
export const PRIVATE_ID_KEY = 'taskdyId';
export const PRIVATE_KIND_KEY = 'taskdyKind';

/** Marcador na descrição do calendário dedicado (calendários não têm extendedProperties). */
export const TASKDY_CALENDAR_MARKER = '[taskdyCalendar=1]';

export const DEFAULT_TZ = 'America/Sao_Paulo';

/** Limites do DTO de evento — o que vem do Google é truncado para caber. */
const TITLE_MAX = 255;
const DESCRIPTION_MAX = 2000;
const LOCATION_MAX = 255;

const DONE_PREFIX = '✓ ';
const TASK_TIMED_DEFAULT_MINUTES = 30;

export interface LocalException {
  originalDate: Date;
  isCancelled: boolean;
  overrideTitle: string | null;
  overrideDescription: string | null;
  overrideStartsAt: Date | null;
  overrideEndsAt: Date | null;
  overrideLocation: string | null;
}

export interface LocalEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  rrule: string | null;
  companyId: string | null;
  exceptions: LocalException[];
}

export interface GoogleInstanceOverride {
  originalDate: Date;
  /** Sufixo do id da instância no Google: `<idDaSérie>_<sufixo>`. */
  instanceSuffix: string;
  body: GoogleEvent;
}

export interface GoogleEventPayload {
  master: GoogleEvent;
  overrides: GoogleInstanceOverride[];
}

export interface LocalTask {
  id: string;
  title: string;
  startDate: Date | null;
  dueDate: Date;
  allDay: boolean;
  timezone: string;
  isDone: boolean;
  url: string;
}

export interface RemoteEventData {
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  rrule: string | null;
  /** Ocorrências removidas da série (EXDATE) — viram exceções canceladas. */
  cancelledDates: Date[];
}

export interface RemoteEventMapping {
  data: RemoteEventData;
  /** false = a recorrência não tem tradução fiel; importa somente-leitura (Q10). */
  mappable: boolean;
}

export interface RemoteInstanceData {
  originalDate: Date;
  isCancelled: boolean;
  overrideTitle: string | null;
  overrideDescription: string | null;
  overrideLocation: string | null;
  overrideStartsAt: Date | null;
  overrideEndsAt: Date | null;
}

// ── TaskDY → Google ─────────────────────────────────────────────────────────────

export function eventToGoogle(ev: LocalEvent): GoogleEventPayload {
  const tz = ev.timezone || DEFAULT_TZ;
  const master: GoogleEvent = {
    summary: ev.title,
    description: ev.description ?? '',
    location: ev.location ?? '',
    ...toGoogleTimes(ev.startsAt, ev.endsAt, ev.allDay, tz),
    recurrence: recurrenceToGoogle(ev),
    // Lembretes não sincronizam (Q16): o Google aplica o padrão do calendário.
    reminders: { useDefault: true },
    // Evento de empresa não expõe detalhes em agenda compartilhada (Q16).
    visibility: ev.companyId ? 'private' : 'default',
    status: 'confirmed',
    extendedProperties: { private: { [PRIVATE_ID_KEY]: ev.id, [PRIVATE_KIND_KEY]: 'event' } },
  };

  const overrides: GoogleInstanceOverride[] = [];
  if (ev.rrule) {
    const durationMs = ev.endsAt.getTime() - ev.startsAt.getTime();
    for (const ex of ev.exceptions) {
      if (ex.isCancelled) continue; // vai como EXDATE na série
      const hasOverride =
        ex.overrideTitle != null ||
        ex.overrideDescription != null ||
        ex.overrideLocation != null ||
        ex.overrideStartsAt != null ||
        ex.overrideEndsAt != null;
      if (!hasOverride) continue;
      const start = ex.overrideStartsAt ?? ex.originalDate;
      const end = ex.overrideEndsAt ?? new Date(start.getTime() + durationMs);
      overrides.push({
        originalDate: ex.originalDate,
        instanceSuffix: instanceSuffix(ex.originalDate, ev.allDay, tz),
        body: {
          summary: ex.overrideTitle ?? ev.title,
          description: ex.overrideDescription ?? ev.description ?? '',
          location: ex.overrideLocation ?? ev.location ?? '',
          ...toGoogleTimes(start, end, ev.allDay, tz),
          originalStartTime: ev.allDay
            ? { date: ymd(ex.originalDate, tz) }
            : { dateTime: ex.originalDate.toISOString(), timeZone: tz },
          status: 'confirmed',
        },
      });
    }
  }

  return { master, overrides };
}

/**
 * Tarefa → evento somente-leitura (Q2/Q11). `startDate→dueDate` quando há início;
 * senão o dia do prazo. Hora 00:00 é a convenção do app para "sem horário", então
 * conta como dia inteiro.
 */
export function taskToGoogle(task: LocalTask): GoogleEvent {
  const tz = task.timezone || DEFAULT_TZ;
  const due = task.dueDate;
  const start = task.startDate && task.startDate <= due ? task.startDate : null;
  const isMidnight = (d: Date) => formatInTimeZone(d, tz, 'HH:mm') === '00:00';
  const allDay = task.allDay || (isMidnight(due) && (!start || isMidnight(start)));

  let times: Pick<GoogleEvent, 'start' | 'end'>;
  if (allDay) {
    times = toGoogleTimes(start ?? due, due, true, tz);
  } else if (start) {
    const end =
      due.getTime() > start.getTime() ? due : addMinutes(start, TASK_TIMED_DEFAULT_MINUTES);
    times = toGoogleTimes(start, end, false, tz);
  } else {
    times = toGoogleTimes(addMinutes(due, -TASK_TIMED_DEFAULT_MINUTES), due, false, tz);
  }

  return {
    summary: `${task.isDone ? DONE_PREFIX : ''}${task.title}`,
    description: `Tarefa do TaskDY — edite pelo TaskDY (mudanças feitas aqui são desfeitas).\n${task.url}`,
    source: { title: 'TaskDY', url: task.url },
    ...times,
    // Prazo não ocupa a agenda (não bloqueia horário livre/ocupado).
    transparency: 'transparent',
    visibility: 'private',
    reminders: { useDefault: true },
    status: 'confirmed',
    extendedProperties: { private: { [PRIVATE_ID_KEY]: task.id, [PRIVATE_KIND_KEY]: 'task' } },
  };
}

function toGoogleTimes(
  start: Date,
  end: Date,
  allDay: boolean,
  tz: string,
): Pick<GoogleEvent, 'start' | 'end'> {
  if (allDay) {
    // TaskDY guarda o último dia inclusivo; o Google quer o fim exclusivo.
    const startDay = ymd(start, tz);
    const endDay = ymd(end, tz);
    const lastDay = endDay < startDay ? startDay : endDay;
    return { start: { date: startDay }, end: { date: addDays(lastDay, 1) } };
  }
  const safeEnd = end.getTime() < start.getTime() ? start : end;
  return {
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: safeEnd.toISOString(), timeZone: tz },
  };
}

function recurrenceToGoogle(ev: LocalEvent): string[] {
  if (!ev.rrule) return [];
  const tz = ev.timezone || DEFAULT_TZ;
  const lines: string[] = [];
  const exdates = ev.exceptions.filter((e) => e.isCancelled).map((e) => e.originalDate);

  if (ev.rrule.startsWith('RDATES=')) {
    const dates = parseRdatesCsv(ev.rrule);
    const startDay = ymd(ev.startsAt, tz);
    const wall = formatInTimeZone(ev.startsAt, tz, 'HHmmss');
    const extra = dates.filter((d) => d !== startDay);
    if (extra.length > 0) {
      lines.push(
        ev.allDay
          ? `RDATE;VALUE=DATE:${extra.map(compactDate).join(',')}`
          : `RDATE;TZID=${tz}:${extra.map((d) => `${compactDate(d)}T${wall}`).join(',')}`,
      );
    }
    // No Google o DTSTART é sempre uma ocorrência; no TaskDY ele é só a âncora de horário.
    if (!dates.includes(startDay)) exdates.push(ev.startsAt);
  } else {
    lines.push(`RRULE:${untilToGoogle(ev.rrule, ev.allDay, tz)}`);
  }

  if (exdates.length > 0) {
    const sorted = [...exdates].sort((a, b) => a.getTime() - b.getTime());
    lines.push(
      ev.allDay
        ? `EXDATE;VALUE=DATE:${sorted.map((d) => compactDate(ymd(d, tz))).join(',')}`
        : `EXDATE;TZID=${tz}:${sorted.map((d) => formatInTimeZone(d, tz, "yyyyMMdd'T'HHmmss")).join(',')}`,
    );
  }
  return lines;
}

/**
 * O TaskDY expande a RRULE em "relógio de parede" (UNTIL é hora local do evento); o
 * Google lê UNTIL com `Z` como UTC de verdade. Converte para o instante real.
 */
function untilToGoogle(rrule: string, allDay: boolean, tz: string): string {
  return rrule.replace(/UNTIL=(\d{8})(?:T(\d{6})Z?)?/i, (_m, date: string, time?: string) => {
    if (allDay) return `UNTIL=${date}`;
    const wall = `${isoDate(date)}T${time ? isoTime(time) : '23:59:59'}`;
    return `UNTIL=${formatUtcCompact(fromZonedTime(wall, tz))}`;
  });
}

function untilFromGoogle(rrule: string, allDay: boolean, tz: string): string {
  return rrule.replace(
    /UNTIL=(\d{8})(?:T(\d{6})(Z?))?/i,
    (_m, date: string, time?: string, z?: string) => {
      if (!time || allDay) return `UNTIL=${date}`;
      const instant = z
        ? new Date(`${isoDate(date)}T${isoTime(time)}Z`)
        : fromZonedTime(`${isoDate(date)}T${isoTime(time)}`, tz);
      return `UNTIL=${formatInTimeZone(instant, tz, "yyyyMMdd'T'HHmmss")}Z`;
    },
  );
}

export function instanceSuffix(originalDate: Date, allDay: boolean, tz: string): string {
  return allDay ? compactDate(ymd(originalDate, tz)) : formatUtcCompact(originalDate);
}

// ── Google → TaskDY ─────────────────────────────────────────────────────────────

/** null quando o evento não traz horário (ex.: cancelado sem corpo). */
export function googleToEventData(
  g: GoogleEvent,
  calendarTz?: string | null,
): RemoteEventMapping | null {
  const tz = g.start?.timeZone || calendarTz || DEFAULT_TZ;
  const times = fromGoogleTimes(g.start, g.end, tz);
  if (!times) return null;

  const rec = recurrenceFromGoogle(g.recurrence ?? [], times.startsAt, times.allDay, tz);
  return {
    mappable: rec.mappable,
    data: {
      title: truncate(g.summary?.trim() || '(sem título)', TITLE_MAX),
      description: g.description ? truncate(g.description, DESCRIPTION_MAX) : null,
      location: g.location ? truncate(g.location, LOCATION_MAX) : null,
      allDay: times.allDay,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      timezone: tz,
      rrule: rec.rrule,
      cancelledDates: rec.cancelledDates,
    },
  };
}

/** Instância alterada/cancelada de uma série (`recurringEventId`) → exceção do TaskDY. */
export function googleInstanceToException(
  g: GoogleEvent,
  master: { allDay: boolean; timezone: string },
): RemoteInstanceData | null {
  const tz = master.timezone || DEFAULT_TZ;
  const orig = g.originalStartTime;
  const originalDate = orig?.dateTime
    ? new Date(orig.dateTime)
    : orig?.date
      ? fromZonedTime(`${orig.date}T00:00:00`, tz)
      : null;
  if (!originalDate || Number.isNaN(originalDate.getTime())) return null;

  if (g.status === 'cancelled') {
    return {
      originalDate,
      isCancelled: true,
      overrideTitle: null,
      overrideDescription: null,
      overrideLocation: null,
      overrideStartsAt: null,
      overrideEndsAt: null,
    };
  }

  const times = fromGoogleTimes(g.start, g.end, tz);
  return {
    originalDate,
    isCancelled: false,
    overrideTitle: g.summary ? truncate(g.summary, TITLE_MAX) : null,
    overrideDescription: g.description ? truncate(g.description, DESCRIPTION_MAX) : null,
    overrideLocation: g.location ? truncate(g.location, LOCATION_MAX) : null,
    overrideStartsAt: times?.startsAt ?? null,
    overrideEndsAt: times?.endsAt ?? null,
  };
}

function fromGoogleTimes(
  start: calendar_v3.Schema$EventDateTime | undefined,
  end: calendar_v3.Schema$EventDateTime | undefined,
  tz: string,
): { allDay: boolean; startsAt: Date; endsAt: Date } | null {
  if (start?.date) {
    const startsAt = fromZonedTime(`${start.date}T00:00:00`, tz);
    // Fim exclusivo no Google → último dia inclusivo no TaskDY.
    const lastDay = end?.date ? addDays(end.date, -1) : start.date;
    const endsAt = fromZonedTime(`${lastDay < start.date ? start.date : lastDay}T00:00:00`, tz);
    return { allDay: true, startsAt, endsAt };
  }
  if (start?.dateTime) {
    const startsAt = new Date(start.dateTime);
    const endsAt = end?.dateTime ? new Date(end.dateTime) : startsAt;
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
    return { allDay: false, startsAt, endsAt: endsAt < startsAt ? startsAt : endsAt };
  }
  return null;
}

/**
 * Tradução da recorrência (Q10): uma RRULE (+EXDATE) ou só RDATEs no mesmo horário
 * viram o formato do TaskDY. O resto (EXRULE, várias RRULE, RRULE+RDATE, RDATE em
 * horários diferentes, FREQ fora de DAILY..YEARLY) é importado somente-leitura, com a
 * melhor aproximação possível.
 */
function recurrenceFromGoogle(
  lines: string[],
  startsAt: Date,
  allDay: boolean,
  tz: string,
): { rrule: string | null; cancelledDates: Date[]; mappable: boolean } {
  const rrules: string[] = [];
  const rdates: Date[] = [];
  const exdates: Date[] = [];
  let mappable = true;

  for (const raw of lines) {
    const line = raw.trim();
    const upper = line.toUpperCase();
    if (upper.startsWith('RRULE:')) rrules.push(line.slice('RRULE:'.length));
    else if (upper.startsWith('RDATE')) {
      const parsed = parseDateList(line, allDay, startsAt, tz);
      if (!parsed) mappable = false;
      else rdates.push(...parsed);
    } else if (upper.startsWith('EXDATE')) {
      const parsed = parseDateList(line, allDay, startsAt, tz);
      if (!parsed) mappable = false;
      else exdates.push(...parsed);
    } else if (line) mappable = false; // EXRULE e afins
  }

  if (rrules.length > 1 || (rrules.length > 0 && rdates.length > 0)) mappable = false;

  let rrule: string | null = null;
  if (rrules.length > 0) {
    const normalized = normalizeRrule(untilFromGoogle(rrules[0], allDay, tz));
    if (normalized) rrule = normalized;
    else mappable = false;
  } else if (rdates.length > 0) {
    const wall = formatInTimeZone(startsAt, tz, 'HH:mm');
    const sameWall = rdates.every((d) => allDay || formatInTimeZone(d, tz, 'HH:mm') === wall);
    if (sameWall) {
      // Datas removidas saem da lista em vez de virar exceção cancelada.
      const removed = new Set(exdates.map((d) => ymd(d, tz)));
      const days = new Set([ymd(startsAt, tz), ...rdates.map((d) => ymd(d, tz))]);
      rrule = `RDATES=${[...days]
        .filter((d) => !removed.has(d))
        .sort()
        .join(',')}`;
      return { rrule, cancelledDates: [], mappable };
    }
    mappable = false;
  }

  // Sem nenhuma recorrência reconhecível, só EXDATE solto não significa nada.
  return { rrule, cancelledDates: rrule ? exdates : [], mappable };
}

/** FREQ primeiro (o DTO do TaskDY exige) e só as frequências que o app suporta. */
function normalizeRrule(body: string): string | null {
  const parts = body
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const freq = parts.find((p) => p.toUpperCase().startsWith('FREQ='));
  if (!freq || !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)$/i.test(freq)) return null;
  const rest = parts.filter((p) => p !== freq);
  const rule = [freq.toUpperCase(), ...rest].join(';');
  try {
    rrulestr(`DTSTART:20260101T000000Z\nRRULE:${rule}`, { forceset: false });
  } catch {
    return null;
  }
  return rule;
}

/**
 * `RDATE;TZID=America/Sao_Paulo:20260105T100000,...`, `EXDATE;VALUE=DATE:20260105`,
 * `EXDATE:20260105T130000Z`. Data sem hora num evento com horário vira a data no
 * horário da série. null = formato não reconhecido (PERIOD etc.).
 */
function parseDateList(line: string, allDay: boolean, startsAt: Date, tz: string): Date[] | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const params = line.slice(0, colon).split(';').slice(1);
  const values = line
    .slice(colon + 1)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const tzid = params.find((p) => p.toUpperCase().startsWith('TZID='))?.slice(5) || tz;
  if (params.some((p) => p.toUpperCase() === 'VALUE=PERIOD')) return null;
  const wall = formatInTimeZone(startsAt, tz, 'HH:mm:ss');

  const out: Date[] = [];
  for (const v of values) {
    const m = /^(\d{8})(?:T(\d{6})(Z?))?$/.exec(v);
    if (!m) return null;
    const [, date, time, z] = m;
    let d: Date;
    if (!time) d = fromZonedTime(`${isoDate(date)}T${allDay ? '00:00:00' : wall}`, tz);
    else if (z) d = new Date(`${isoDate(date)}T${isoTime(time)}Z`);
    else d = fromZonedTime(`${isoDate(date)}T${isoTime(time)}`, tzid);
    if (allDay && time) d = fromZonedTime(`${ymd(d, tz)}T00:00:00`, tz);
    if (Number.isNaN(d.getTime())) return null;
    out.push(d);
  }
  return out;
}

// ── util ────────────────────────────────────────────────────────────────────────

function parseRdatesCsv(rrule: string): string[] {
  return rrule
    .substring('RDATES='.length)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

function ymd(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, 'yyyy-MM-dd');
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000);
}

function compactDate(day: string): string {
  return day.replace(/-/g, '');
}

function isoDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function isoTime(compact: string): string {
  return `${compact.slice(0, 2)}:${compact.slice(2, 4)}:${compact.slice(4, 6)}`;
}

function formatUtcCompact(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
