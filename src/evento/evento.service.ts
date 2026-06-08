import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { rrulestr } from 'rrule';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  AttendeeStatus,
  EventVisibility,
  Prisma,
  ReminderMethod,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { CalendarEventWithRelations, EventoRepository } from './evento.repository';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { EventMutationScope, EventMutationScopeDto } from './dto/event-mutation-scope.dto';
import { checkDateRange } from '../common/date-range';

export interface EventOccurrence {
  eventId: string;
  occurrenceKey: string;
  originalDate: string;
  title: string;
  description: string | null;
  location: string | null;
  color: string | null;
  allDay: boolean;
  startsAt: string;
  endsAt: string;
  timezone: string;
  visibility: EventVisibility;
  isRecurringInstance: boolean;
  isOwner: boolean;
  myRsvpStatus: AttendeeStatus | null;
  attendees: {
    userId: string;
    name: string;
    email: string;
    photoUrl: string | null;
    status: AttendeeStatus;
  }[];
  reminders: { minutesBefore: number; method: ReminderMethod }[];
  guestEmails: string[];
  taskId: string | null;
  workspaceId: string | null;
  companyId: string | null;
}

@Injectable()
export class EventoService {
  constructor(
    private readonly repo: EventoRepository,
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    @InjectPinoLogger(EventoService.name)
    private readonly logger: PinoLogger,
  ) {}

  async listOccurrences(userId: string, query: ListEventsQueryDto): Promise<EventOccurrence[]> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    // Estende `to` para fim do dia para capturar eventos que iniciam no último dia da janela
    if (query.to.length === 10) {
      to.setUTCHours(23, 59, 59, 999);
    }

    const events = await this.repo.findOverlapping(userId, from, to, {
      companyId: query.companyId,
      workspaceId: query.workspaceId,
    });

    const occurrences: EventOccurrence[] = [];
    for (const ev of events) {
      occurrences.push(...this.expandEvent(ev, from, to, userId));
    }

    occurrences.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return occurrences;
  }

  private expandEvent(
    ev: CalendarEventWithRelations,
    from: Date,
    to: Date,
    viewerId: string,
  ): EventOccurrence[] {
    const baseDurationMs = ev.endsAt.getTime() - ev.startsAt.getTime();
    const exceptionsMap = new Map(ev.exceptions.map((ex) => [ex.originalDate.toISOString(), ex]));

    let rawDates: Date[];
    if (!ev.rrule) {
      // Não recorrente — única ocorrência (se cair em [from, to])
      if (ev.startsAt >= from && ev.startsAt <= to) {
        rawDates = [ev.startsAt];
      } else {
        rawDates = [];
      }
    } else if (ev.rrule.startsWith('RDATES=')) {
      // Datas personalizadas: cada data YYYY-MM-DD ancorada no TZ do evento
      rawDates = expandCustomDates(ev.rrule, ev.startsAt, ev.timezone).filter(
        (d) => d >= from && d <= to,
      );
    } else {
      try {
        rawDates = expandRruleInTimezone(ev.rrule, ev.startsAt, ev.timezone, from, to);
      } catch (err) {
        this.logger.warn(
          { eventId: ev.id, rrule: ev.rrule, err: (err as Error).message },
          'Falha ao parsear RRULE — pulando expansão',
        );
        rawDates = [];
      }
    }

    const result: EventOccurrence[] = [];
    for (const occStart of rawDates) {
      const exception = exceptionsMap.get(occStart.toISOString());
      if (exception?.isCancelled) continue;

      const start = exception?.overrideStartsAt ?? occStart;
      const end = exception?.overrideEndsAt ?? new Date(start.getTime() + baseDurationMs);

      const myAttendee = ev.attendees.find((a) => a.userId === viewerId);

      result.push({
        eventId: ev.id,
        occurrenceKey: `${ev.id}::${occStart.toISOString()}`,
        originalDate: occStart.toISOString(),
        title: exception?.overrideTitle ?? ev.title,
        description: exception?.overrideDescription ?? ev.description,
        location: exception?.overrideLocation ?? ev.location,
        color: ev.color,
        allDay: ev.allDay,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timezone: ev.timezone,
        visibility: ev.visibility,
        isRecurringInstance: !!ev.rrule,
        isOwner: ev.ownerId === viewerId,
        myRsvpStatus: myAttendee?.status ?? null,
        attendees: ev.attendees.map((a) => ({
          userId: a.userId,
          name: a.user.name,
          email: a.user.email,
          photoUrl: a.user.photoUrl,
          status: a.status,
        })),
        reminders: ev.reminders.map((r) => ({
          minutesBefore: r.minutesBefore,
          method: r.method,
        })),
        guestEmails: ev.guestEmails.map((g) => g.email),
        taskId: ev.taskId,
        workspaceId: ev.workspaceId,
        companyId: ev.companyId,
      });
    }
    return result;
  }

  async findOne(userId: string, id: string): Promise<CalendarEventWithRelations> {
    const ev = await this.repo.findById(id);
    if (!ev) throw new NotFoundException('Evento não encontrado');
    this.assertCanRead(ev, userId);
    return ev;
  }

  async create(userId: string, dto: CreateEventDto): Promise<CalendarEventWithRelations> {
    this.validateDates(dto.startsAt, dto.endsAt);
    const tz = dto.timezone ?? 'America/Sao_Paulo';
    if (dto.rrule) this.validateRrule(dto.rrule, dto.startsAt, tz);

    const recurrenceEndAt = dto.rrule
      ? this.computeRecurrenceEndAt(dto.rrule, dto.startsAt, tz)
      : null;

    const data: Prisma.CalendarEventCreateInput = {
      title: dto.title,
      description: dto.description ?? null,
      location: dto.location ?? null,
      color: dto.color ?? null,
      allDay: dto.allDay,
      startsAt: new Date(dto.startsAt),
      endsAt: new Date(dto.endsAt),
      timezone: dto.timezone ?? 'America/Sao_Paulo',
      rrule: dto.rrule ?? null,
      recurrenceEndAt,
      visibility: dto.visibility ?? EventVisibility.private,
      owner: { connect: { id: userId } },
      ...(dto.companyId ? { company: { connect: { id: dto.companyId } } } : {}),
      ...(dto.workspaceId ? { workspace: { connect: { id: dto.workspaceId } } } : {}),
      ...(dto.taskId ? { task: { connect: { id: dto.taskId } } } : {}),
      ...(dto.attendeeUserIds && dto.attendeeUserIds.length > 0
        ? {
            attendees: {
              create: dto.attendeeUserIds
                .filter((uid) => uid !== userId)
                .map((uid) => ({ userId: uid })),
            },
          }
        : {}),
      ...(dto.reminders && dto.reminders.length > 0
        ? {
            reminders: {
              create: dto.reminders.map((r) => ({
                minutesBefore: r.minutesBefore,
                method: r.method ?? ReminderMethod.notification,
              })),
            },
          }
        : {}),
      ...(dto.guestEmails && dto.guestEmails.length > 0
        ? {
            guestEmails: {
              create: [
                ...new Set(dto.guestEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
              ].map((email) => ({ email })),
            },
          }
        : {}),
    };

    const created = await this.repo.create(data);
    this.logger.info(
      { eventId: created.id, ownerId: userId, recurring: !!dto.rrule },
      'CalendarEvent criado',
    );
    void this.notifyAttendees(created, 'created');
    return created;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateEventDto,
    scopeDto: EventMutationScopeDto,
  ): Promise<CalendarEventWithRelations> {
    const ev = await this.repo.findById(id);
    if (!ev) throw new NotFoundException('Evento não encontrado');
    this.assertOwner(ev, userId);

    const scope = scopeDto.scope ?? EventMutationScope.all;

    if (scope === EventMutationScope.single) {
      if (!scopeDto.originalDate) {
        throw new ForbiddenException('originalDate é obrigatório para scope=single');
      }
      const originalDate = new Date(scopeDto.originalDate);
      await this.repo.upsertException(id, originalDate, {
        eventId: id,
        originalDate,
        isCancelled: false,
        overrideTitle: dto.title ?? null,
        overrideDescription: dto.description ?? null,
        overrideLocation: dto.location ?? null,
        overrideStartsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        overrideEndsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      });
      const updated = await this.repo.findById(id);
      return updated as CalendarEventWithRelations;
    }

    // scope === all (scope=future ainda não implementado em v1)
    if (dto.startsAt && dto.endsAt) {
      this.validateDates(dto.startsAt, dto.endsAt);
    }
    const nextRrule = dto.rrule === undefined ? ev.rrule : dto.rrule || null;
    const nextStartsAt = dto.startsAt ? new Date(dto.startsAt) : ev.startsAt;
    const nextTimezone = dto.timezone ?? ev.timezone;
    if (nextRrule) {
      this.validateRrule(nextRrule, nextStartsAt.toISOString(), nextTimezone);
    }

    const data: Prisma.CalendarEventUpdateInput = {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.location !== undefined && { location: dto.location }),
      ...(dto.color !== undefined && { color: dto.color }),
      ...(dto.allDay !== undefined && { allDay: dto.allDay }),
      ...(dto.startsAt && { startsAt: new Date(dto.startsAt) }),
      ...(dto.endsAt && { endsAt: new Date(dto.endsAt) }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      ...(dto.rrule !== undefined && {
        rrule: nextRrule,
        recurrenceEndAt: nextRrule
          ? this.computeRecurrenceEndAt(nextRrule, nextStartsAt.toISOString(), nextTimezone)
          : null,
      }),
      ...(dto.visibility !== undefined && { visibility: dto.visibility }),
      ...(dto.taskId !== undefined && {
        task: dto.taskId ? { connect: { id: dto.taskId } } : { disconnect: true },
      }),
    };

    const updated = await this.repo.update(id, data);

    if (dto.attendeeUserIds !== undefined) {
      await this.replaceAttendees(id, userId, dto.attendeeUserIds);
    }
    if (dto.reminders !== undefined) {
      await this.repo.replaceReminders(id, dto.reminders);
    }
    if (dto.guestEmails !== undefined) {
      await this.repo.replaceGuestEmails(id, dto.guestEmails);
    }

    this.logger.info({ eventId: id, ownerId: userId }, 'CalendarEvent atualizado');
    const refreshed = await this.repo.findById(id);
    if (refreshed) void this.notifyAttendees(refreshed, 'updated');
    return refreshed ?? updated;
  }

  async delete(userId: string, id: string, scopeDto: EventMutationScopeDto): Promise<void> {
    const ev = await this.repo.findById(id);
    if (!ev) throw new NotFoundException('Evento não encontrado');
    this.assertOwner(ev, userId);

    const scope = scopeDto.scope ?? EventMutationScope.all;
    if (scope === EventMutationScope.single) {
      if (!scopeDto.originalDate) {
        throw new ForbiddenException('originalDate é obrigatório para scope=single');
      }
      const originalDate = new Date(scopeDto.originalDate);
      await this.repo.upsertException(id, originalDate, {
        eventId: id,
        originalDate,
        isCancelled: true,
      });
      this.logger.info(
        { eventId: id, originalDate: scopeDto.originalDate },
        'Ocorrência cancelada',
      );
      return;
    }

    await this.repo.softDelete(id);
    this.logger.info({ eventId: id }, 'CalendarEvent deletado');
    void this.notifyAttendees(ev, 'cancelled');
  }

  async inviteAttendee(userId: string, eventId: string, attendeeId: string) {
    const ev = await this.repo.findById(eventId);
    if (!ev) throw new NotFoundException('Evento não encontrado');
    this.assertOwner(ev, userId);
    if (attendeeId === userId) {
      throw new ForbiddenException('Você é o dono — não precisa se convidar');
    }
    return this.repo.addAttendee(eventId, attendeeId);
  }

  async removeAttendee(userId: string, eventId: string, attendeeId: string) {
    const ev = await this.repo.findById(eventId);
    if (!ev) throw new NotFoundException('Evento não encontrado');
    this.assertOwner(ev, userId);
    await this.repo.removeAttendee(eventId, attendeeId);
  }

  async rsvp(userId: string, eventId: string, status: AttendeeStatus) {
    const ev = await this.repo.findById(eventId);
    if (!ev) throw new NotFoundException('Evento não encontrado');
    const attendee = await this.repo.findAttendee(eventId, userId);
    if (!attendee) {
      throw new ForbiddenException('Você não foi convidado para este evento');
    }
    return this.repo.setRsvp(eventId, userId, status);
  }

  // --- helpers ---

  private assertCanRead(ev: CalendarEventWithRelations, userId: string) {
    const isAttendee = ev.attendees.some((a) => a.userId === userId);
    if (ev.ownerId !== userId && !isAttendee) {
      throw new NotFoundException('Evento não encontrado');
    }
  }

  private assertOwner(ev: CalendarEventWithRelations, userId: string) {
    if (ev.ownerId !== userId) {
      throw new ForbiddenException('Apenas o dono pode editar este evento');
    }
  }

  private validateDates(startsAt: string, endsAt: string) {
    const { invalid, outOfOrder } = checkDateRange(startsAt, endsAt);
    if (invalid) {
      throw new ForbiddenException('Datas inválidas');
    }
    if (outOfOrder) {
      throw new ForbiddenException('endsAt deve ser >= startsAt');
    }
  }

  private validateRrule(rrule: string, dtstartIso: string, timezone = 'America/Sao_Paulo') {
    if (rrule.startsWith('RDATES=')) {
      const dates = expandCustomDates(rrule, new Date(dtstartIso), timezone);
      if (dates.some((d) => Number.isNaN(d.getTime()))) {
        throw new ForbiddenException('RDATES contém data inválida');
      }
      return;
    }
    try {
      const dtstart = formatDtstartUtc(new Date(dtstartIso));
      rrulestr(`DTSTART:${dtstart}\nRRULE:${rrule}`, { forceset: false });
    } catch (err) {
      throw new ForbiddenException(`RRULE inválida: ${(err as Error).message}`);
    }
  }

  private computeRecurrenceEndAt(
    rrule: string,
    dtstartIso: string,
    timezone = 'America/Sao_Paulo',
  ): Date | null {
    if (rrule.startsWith('RDATES=')) {
      const dates = expandCustomDates(rrule, new Date(dtstartIso), timezone);
      if (dates.length === 0) return null;
      return dates.reduce((max, d) => (d > max ? d : max));
    }
    const upper = rrule.toUpperCase();
    if (!upper.includes('UNTIL=') && !upper.includes('COUNT=')) {
      return null; // recorrência infinita
    }
    try {
      const dtstart = formatDtstartUtc(new Date(dtstartIso));
      const rule = rrulestr(`DTSTART:${dtstart}\nRRULE:${rrule}`, {
        forceset: false,
      });
      const all = rule.all((_, i) => i < 1000);
      return all.length > 0 ? all[all.length - 1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Notifica destinatários (attendees registrados + guest emails externos) sobre
   * criação/update/cancelamento. Roda em background — falhas não interrompem a mutação.
   * Owner não recebe (ele que criou/editou).
   */
  private async notifyAttendees(
    ev: CalendarEventWithRelations,
    kind: 'created' | 'updated' | 'cancelled',
  ): Promise<void> {
    try {
      const recipients = new Set<string>();
      for (const a of ev.attendees) {
        if (a.user?.email) recipients.add(a.user.email.toLowerCase());
      }
      for (const g of ev.guestEmails) {
        if (g.email) recipients.add(g.email.toLowerCase());
      }
      if (recipients.size === 0) return;

      const owner = await this.prisma.user.findUnique({
        where: { id: ev.ownerId },
        select: { name: true },
      });

      await Promise.all(
        [...recipients].map((to) =>
          this.mailer.sendEventNotificationEmail({
            to,
            kind,
            title: ev.title,
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            location: ev.location,
            description: ev.description,
            timezone: ev.timezone,
            organizerName: owner?.name ?? null,
          }),
        ),
      );
    } catch (err) {
      this.logger.warn(
        { eventId: ev.id, kind, err: (err as Error).message },
        'Falha em notifyAttendees — ignorada',
      );
    }
  }

  private async replaceAttendees(eventId: string, ownerId: string, userIds: string[]) {
    const desired = new Set(userIds.filter((u) => u !== ownerId));
    const current = await this.prisma.calendarEventAttendee.findMany({
      where: { eventId },
      select: { userId: true },
    });
    const currentSet = new Set(current.map((c) => c.userId));

    const toAdd = [...desired].filter((u) => !currentSet.has(u));
    const toRemove = [...currentSet].filter((u) => !desired.has(u));

    await this.prisma.$transaction([
      ...(toRemove.length > 0
        ? [
            this.prisma.calendarEventAttendee.deleteMany({
              where: { eventId, userId: { in: toRemove } },
            }),
          ]
        : []),
      ...(toAdd.length > 0
        ? [
            this.prisma.calendarEventAttendee.createMany({
              data: toAdd.map((userId) => ({ eventId, userId })),
            }),
          ]
        : []),
    ]);
  }
}

function formatDtstartUtc(date: Date): string {
  // Formato iCal UTC: YYYYMMDDTHHMMSSZ
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Expande string `RDATES=YYYY-MM-DD,YYYY-MM-DD,...` em datas concretas.
 * Cada data é interpretada no timezone do evento, com o wall-clock-time do baseStartsAt.
 * Isso garante que se o evento original é "2026-05-01 14:00 BRT", uma data picada
 * "2026-12-15" também será "2026-12-15 14:00 no TZ do evento" — independente de DST.
 */
function expandCustomDates(rrule: string, baseStartsAt: Date, timezone: string): Date[] {
  const csv = rrule.substring('RDATES='.length);
  if (!csv) return [];

  // Wall-clock-time do startsAt no timezone do evento
  const wallTime = formatInTimeZone(baseStartsAt, timezone, 'HH:mm:ss');

  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((dateStr) => {
      // dateStr = "YYYY-MM-DD" — combina com wallTime e interpreta no TZ do evento
      try {
        return fromZonedTime(`${dateStr}T${wallTime}`, timezone);
      } catch {
        return new Date(NaN);
      }
    });
}

/**
 * Expande RRULE preservando o wall-clock-time no timezone do evento.
 *
 * Estratégia: rrule.lib expande em UTC. Cada ocorrência U_n é convertida para a data
 * "calendário" no TZ do evento, e então reconstruída como "data-no-TZ + wall-clock-time
 * original" → UTC novamente. Isso garante que ocorrências em datas com DST diferente
 * mantêm o mesmo horário local (ex: 14:00 BRT antes do DST e 14:00 BRT depois).
 */
function expandRruleInTimezone(
  rrule: string,
  baseStartsAt: Date,
  timezone: string,
  from: Date,
  to: Date,
): Date[] {
  // Wall-clock no TZ do evento (data + hora original)
  const baseWallDate = formatInTimeZone(baseStartsAt, timezone, 'yyyy-MM-dd');
  const baseWallTime = formatInTimeZone(baseStartsAt, timezone, 'HH:mm:ss');

  // Reconstrói o "âncora UTC" usando wall-clock-time fictício em UTC.
  // Como rrule é tz-naive, alimentamos um DTSTART em UTC que corresponde ao wall-clock,
  // expandimos, depois traduzimos cada ocorrência de volta com fromZonedTime.
  const fakeUtcAnchor = new Date(`${baseWallDate}T${baseWallTime}.000Z`);
  const dtstart = formatDtstartUtc(fakeUtcAnchor);
  const rule = rrulestr(`DTSTART:${dtstart}\nRRULE:${rrule}`, { forceset: false });

  // Janela de busca também precisa ser convertida — pegamos uma janela mais ampla
  // pra cobrir bordas de offset (até 14h em qualquer direção).
  const fromExpanded = new Date(from.getTime() - 14 * 3600_000);
  const toExpanded = new Date(to.getTime() + 14 * 3600_000);
  const utcCandidates = rule.between(fromExpanded, toExpanded, true);

  const result: Date[] = [];
  for (const utcCandidate of utcCandidates) {
    // Extrai a "data calendário" (YYYY-MM-DD) que essa ocorrência representa.
    // Como expandimos em UTC com wall-clock UTC, o YYYY-MM-DD do utcCandidate
    // é exatamente a data calendário desejada no TZ do evento.
    const yyyy = utcCandidate.getUTCFullYear();
    const mm = String(utcCandidate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(utcCandidate.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    try {
      const realUtc = fromZonedTime(`${dateStr}T${baseWallTime}`, timezone);
      if (realUtc >= from && realUtc <= to) {
        result.push(realUtc);
      }
    } catch {
      // ignora data inválida
    }
  }
  return result;
}
