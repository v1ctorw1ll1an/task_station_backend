import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { rrulestr } from 'rrule';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { NotificationType, ReminderMethod } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { NotificacaoService } from '../notificacao/notificacao.service';

interface PendingReminder {
  reminderId: string;
  method: ReminderMethod;
  /** ID do user (owner ou attendee) ou prefixo "guest:" + email para externos */
  recipientId: string;
  /** Apenas para method=email. Para notification, sempre é um user real (sem guest). */
  recipientEmail: string;
  /** ID real do User quando recipient é um user (não guest:) — null para guest emails. */
  recipientUserId: string | null;
  eventId: string;
  eventTitle: string;
  eventLocation: string | null;
  eventDescription: string | null;
  eventTimezone: string;
  occurrenceStart: Date;
  occurrenceEnd: Date;
  originalDate: Date;
  minutesBefore: number;
}

@Injectable()
export class ReminderDispatcherService {
  // Janela de varredura: pega lembretes cujo trigger cai em [now, now + WINDOW_MIN min]
  // Como o cron roda a cada minuto, 2 min de janela cobre atrasos sem duplicar (idempotência via tabela sent)
  private static readonly WINDOW_MINUTES = 2;
  // Quantos dias à frente expandir RRULEs (limite para não estourar memória em recorrências infinitas)
  private static readonly EXPAND_AHEAD_DAYS = 32;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly notificacao: NotificacaoService,
    @InjectPinoLogger(ReminderDispatcherService.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + ReminderDispatcherService.WINDOW_MINUTES * 60_000);

    try {
      const pending = await this.findPendingReminders(now, windowEnd);
      if (pending.length === 0) return;

      this.logger.debug({ count: pending.length }, 'Disparando lembretes');

      for (const item of pending) {
        await this.dispatchOne(item);
      }
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message },
        'Falha geral no tick do reminder dispatcher',
      );
    }
  }

  private async findPendingReminders(now: Date, windowEnd: Date): Promise<PendingReminder[]> {
    // O lembrete dispara em (occurrenceStart - minutesBefore). Para o trigger cair em [now, windowEnd]
    // precisamos de ocorrências em [now + minMinutes, windowEnd + maxMinutes].
    // Em vez de calcular cada janela por reminder, expandimos toda a janela ampla "EXPAND_AHEAD_DAYS"
    // — barato porque só consideramos eventos com reminders e a expansão é limitada a este horizonte.

    const horizonEnd = new Date(
      now.getTime() + ReminderDispatcherService.EXPAND_AHEAD_DAYS * 86_400_000,
    );

    const events = await this.prisma.calendarEvent.findMany({
      where: {
        deletedAt: null,
        reminders: { some: {} },
        // Pode ser série recorrente OU evento simples futuro
        OR: [
          { rrule: null, startsAt: { gte: now, lte: horizonEnd } },
          {
            rrule: { not: null },
            startsAt: { lte: horizonEnd },
            OR: [{ recurrenceEndAt: null }, { recurrenceEndAt: { gte: now } }],
          },
        ],
      },
      include: {
        reminders: true,
        attendees: {
          where: { status: { in: ['accepted', 'tentative', 'invited'] } },
          include: { user: { select: { id: true, email: true } } },
        },
        guestEmails: true,
        owner: { select: { id: true, email: true } },
        exceptions: true,
      },
    });

    if (events.length === 0) return [];

    const result: PendingReminder[] = [];

    for (const ev of events) {
      const occurrences = this.expandOccurrences(ev, now, horizonEnd);
      const baseDurationMs = ev.endsAt.getTime() - ev.startsAt.getTime();
      const exceptionsMap = new Map(ev.exceptions.map((ex) => [ex.originalDate.toISOString(), ex]));

      for (const occOriginal of occurrences) {
        const exception = exceptionsMap.get(occOriginal.toISOString());
        if (exception?.isCancelled) continue;
        const start = exception?.overrideStartsAt ?? occOriginal;
        const end = exception?.overrideEndsAt ?? new Date(start.getTime() + baseDurationMs);
        const title = exception?.overrideTitle ?? ev.title;
        const location = exception?.overrideLocation ?? ev.location;
        const description = exception?.overrideDescription ?? ev.description;

        for (const reminder of ev.reminders) {
          const triggerAt = new Date(start.getTime() - reminder.minutesBefore * 60_000);
          // - triggerAt > windowEnd: ainda não é hora.
          // - start <= now: a ocorrência já começou (ou já passou) — não dispara backfill.
          //   Triggers no passado (mas com a ocorrência ainda no futuro) DISPARAM. Idempotência
          //   via CalendarEventReminderSent garante que não duplica.
          if (triggerAt > windowEnd) continue;
          if (start <= now) continue;

          // Destinatários: owner + attendees + (apenas para email) guest emails externos.
          // Para method=notification, guests externos não recebem (não têm conta no sistema).
          interface RecipientEntry {
            recipientId: string;
            recipientEmail: string;
            recipientUserId: string | null;
          }
          const recipients = new Map<string, RecipientEntry>();
          if (ev.owner.email) {
            recipients.set(ev.owner.id, {
              recipientId: ev.owner.id,
              recipientEmail: ev.owner.email,
              recipientUserId: ev.owner.id,
            });
          }
          for (const a of ev.attendees) {
            if (a.user?.email) {
              recipients.set(a.user.id, {
                recipientId: a.user.id,
                recipientEmail: a.user.email,
                recipientUserId: a.user.id,
              });
            }
          }
          if (reminder.method === ReminderMethod.email) {
            for (const g of ev.guestEmails) {
              if (g.email) {
                const key = `guest:${g.email.toLowerCase()}`;
                recipients.set(key, {
                  recipientId: key,
                  recipientEmail: g.email,
                  recipientUserId: null,
                });
              }
            }
          }

          for (const entry of recipients.values()) {
            result.push({
              reminderId: reminder.id,
              method: reminder.method,
              recipientId: entry.recipientId,
              recipientEmail: entry.recipientEmail,
              recipientUserId: entry.recipientUserId,
              eventId: ev.id,
              eventTitle: title,
              eventLocation: location,
              eventDescription: description,
              eventTimezone: ev.timezone,
              occurrenceStart: start,
              occurrenceEnd: end,
              originalDate: occOriginal,
              minutesBefore: reminder.minutesBefore,
            });
          }
        }
      }
    }

    return result;
  }

  private expandOccurrences(
    ev: { rrule: string | null; startsAt: Date; timezone: string },
    from: Date,
    to: Date,
  ): Date[] {
    if (!ev.rrule) {
      return ev.startsAt >= from && ev.startsAt <= to ? [ev.startsAt] : [];
    }
    if (ev.rrule.startsWith('RDATES=')) {
      const csv = ev.rrule.substring('RDATES='.length);
      const wallTime = formatInTimeZone(ev.startsAt, ev.timezone, 'HH:mm:ss');
      return csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((dateStr) => {
          try {
            return fromZonedTime(`${dateStr}T${wallTime}`, ev.timezone);
          } catch {
            return new Date(NaN);
          }
        })
        .filter((d) => !Number.isNaN(d.getTime()) && d >= from && d <= to);
    }
    try {
      const baseWallDate = formatInTimeZone(ev.startsAt, ev.timezone, 'yyyy-MM-dd');
      const baseWallTime = formatInTimeZone(ev.startsAt, ev.timezone, 'HH:mm:ss');
      const fakeUtcAnchor = new Date(`${baseWallDate}T${baseWallTime}.000Z`);
      const dtstart = formatDtstartUtc(fakeUtcAnchor);
      const rule = rrulestr(`DTSTART:${dtstart}\nRRULE:${ev.rrule}`, { forceset: false });
      const fromExpanded = new Date(from.getTime() - 14 * 3600_000);
      const toExpanded = new Date(to.getTime() + 14 * 3600_000);
      const utcCandidates = rule.between(fromExpanded, toExpanded, true);
      const result: Date[] = [];
      for (const utcCandidate of utcCandidates) {
        const yyyy = utcCandidate.getUTCFullYear();
        const mm = String(utcCandidate.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(utcCandidate.getUTCDate()).padStart(2, '0');
        try {
          const realUtc = fromZonedTime(`${yyyy}-${mm}-${dd}T${baseWallTime}`, ev.timezone);
          if (realUtc >= from && realUtc <= to) {
            result.push(realUtc);
          }
        } catch {
          // ignora
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  private async dispatchOne(item: PendingReminder): Promise<void> {
    // Idempotência: insere primeiro o registro de envio (unique constraint).
    // Se falhar (já enviado), pula. Caso contrário envia e só no sucesso mantém o registro.
    try {
      await this.prisma.calendarEventReminderSent.create({
        data: {
          reminderId: item.reminderId,
          recipientId: item.recipientId,
          originalDate: item.originalDate,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return; // já enviado
      this.logger.error(
        { err: (err as Error).message, reminderId: item.reminderId },
        'Falha ao registrar reminder sent',
      );
      return;
    }

    try {
      if (item.method === ReminderMethod.email) {
        await this.mailer.sendEventReminderEmail({
          to: item.recipientEmail,
          title: item.eventTitle,
          startsAt: item.occurrenceStart,
          endsAt: item.occurrenceEnd,
          location: item.eventLocation,
          description: item.eventDescription,
          minutesBefore: item.minutesBefore,
          timezone: item.eventTimezone,
        });
      } else {
        // method=notification: persiste Notification e emite WS
        if (!item.recipientUserId) return; // sem user real (guest) — ignora
        const whenStr = formatInTimeZone(
          item.occurrenceStart,
          item.eventTimezone,
          "dd/MM 'às' HH:mm",
        );
        const body =
          item.minutesBefore === 0
            ? `Começa agora (${whenStr})`
            : `Começa em ${item.minutesBefore} min (${whenStr})`;
        await this.notificacao.notify({
          type: NotificationType.EVENT_REMINDER,
          recipientId: item.recipientUserId,
          title: item.eventTitle,
          body,
          metadata: {
            eventId: item.eventId,
            occurrenceStart: item.occurrenceStart.toISOString(),
            occurrenceEnd: item.occurrenceEnd.toISOString(),
            minutesBefore: item.minutesBefore,
            location: item.eventLocation,
          },
        });
      }
    } catch (err) {
      // Falha no envio: remove o registro pra que o próximo tick tente de novo
      await this.prisma.calendarEventReminderSent
        .deleteMany({
          where: {
            reminderId: item.reminderId,
            recipientId: item.recipientId,
            originalDate: item.originalDate,
          },
        })
        .catch(() => undefined);
      this.logger.error(
        {
          err: (err as Error).message,
          reminderId: item.reminderId,
          method: item.method,
          to: item.recipientEmail,
        },
        'Falha ao despachar reminder — registro removido para retry',
      );
    }
  }
}

function formatDtstartUtc(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
