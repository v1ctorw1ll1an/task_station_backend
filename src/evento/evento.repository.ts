import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const eventInclude = {
  attendees: {
    include: {
      user: {
        select: { id: true, name: true, email: true, photoUrl: true },
      },
    },
  },
  reminders: true,
  exceptions: true,
  guestEmails: true,
} satisfies Prisma.CalendarEventInclude;

export type CalendarEventWithRelations = Prisma.CalendarEventGetPayload<{
  include: typeof eventInclude;
}>;

@Injectable()
export class EventoRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<CalendarEventWithRelations | null> {
    return this.prisma.calendarEvent.findFirst({
      where: { id, deletedAt: null },
      include: eventInclude,
    });
  }

  /**
   * Retorna eventos do usuário (próprios OU onde é attendee) cujo intervalo
   * de série pode produzir ocorrências em [from, to].
   *
   * Para eventos não-recorrentes: startsAt entre [from, to].
   * Para eventos recorrentes: startsAt <= to AND (recurrenceEndAt is null OR recurrenceEndAt >= from).
   */
  async findOverlapping(
    userId: string,
    from: Date,
    to: Date,
    filters: { companyId?: string; workspaceId?: string } = {},
  ): Promise<CalendarEventWithRelations[]> {
    const overlapClause: Prisma.CalendarEventWhereInput = {
      OR: [
        // Eventos sem recorrência cujo startsAt cai dentro da janela
        {
          rrule: null,
          startsAt: { gte: from, lte: to },
        },
        // Eventos recorrentes cuja série pode produzir ocorrências na janela
        {
          rrule: { not: null },
          startsAt: { lte: to },
          OR: [{ recurrenceEndAt: null }, { recurrenceEndAt: { gte: from } }],
        },
      ],
    };

    const ownership: Prisma.CalendarEventWhereInput = {
      OR: [{ ownerId: userId }, { attendees: { some: { userId } } }],
    };

    const where: Prisma.CalendarEventWhereInput = {
      AND: [
        ownership,
        overlapClause,
        { deletedAt: null },
        ...(filters.companyId ? [{ companyId: filters.companyId }] : []),
        ...(filters.workspaceId ? [{ workspaceId: filters.workspaceId }] : []),
      ],
    };

    return this.prisma.calendarEvent.findMany({
      where,
      include: eventInclude,
      orderBy: { startsAt: 'asc' },
    });
  }

  async create(data: Prisma.CalendarEventCreateInput): Promise<CalendarEventWithRelations> {
    return this.prisma.calendarEvent.create({
      data,
      include: eventInclude,
    });
  }

  async update(
    id: string,
    data: Prisma.CalendarEventUpdateInput,
  ): Promise<CalendarEventWithRelations> {
    return this.prisma.calendarEvent.update({
      where: { id },
      data,
      include: eventInclude,
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.calendarEvent.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async upsertException(
    eventId: string,
    originalDate: Date,
    data: Prisma.CalendarEventExceptionUncheckedCreateInput,
  ) {
    return this.prisma.calendarEventException.upsert({
      where: { eventId_originalDate: { eventId, originalDate } },
      create: data,
      update: {
        isCancelled: data.isCancelled,
        overrideTitle: data.overrideTitle,
        overrideDescription: data.overrideDescription,
        overrideStartsAt: data.overrideStartsAt,
        overrideEndsAt: data.overrideEndsAt,
        overrideLocation: data.overrideLocation,
      },
    });
  }

  async findAttendee(eventId: string, userId: string) {
    return this.prisma.calendarEventAttendee.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });
  }

  async addAttendee(eventId: string, userId: string) {
    return this.prisma.calendarEventAttendee.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: { eventId, userId },
      update: {},
    });
  }

  async removeAttendee(eventId: string, userId: string) {
    await this.prisma.calendarEventAttendee.deleteMany({
      where: { eventId, userId },
    });
  }

  async setRsvp(
    eventId: string,
    userId: string,
    status: Prisma.CalendarEventAttendeeUpdateInput['status'],
  ) {
    return this.prisma.calendarEventAttendee.update({
      where: { eventId_userId: { eventId, userId } },
      data: { status },
    });
  }

  async replaceReminders(
    eventId: string,
    reminders: { minutesBefore: number; method?: 'notification' | 'email' }[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.calendarEventReminder.deleteMany({ where: { eventId } }),
      ...(reminders.length > 0
        ? [
            this.prisma.calendarEventReminder.createMany({
              data: reminders.map((r) => ({
                eventId,
                minutesBefore: r.minutesBefore,
                method: r.method ?? 'notification',
              })),
            }),
          ]
        : []),
    ]);
  }

  async replaceGuestEmails(eventId: string, emails: string[]): Promise<void> {
    const desired = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    await this.prisma.$transaction([
      this.prisma.calendarEventGuestEmail.deleteMany({ where: { eventId } }),
      ...(desired.length > 0
        ? [
            this.prisma.calendarEventGuestEmail.createMany({
              data: desired.map((email) => ({ eventId, email })),
            }),
          ]
        : []),
    ]);
  }
}
