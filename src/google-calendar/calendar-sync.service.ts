import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { calendar_v3 } from '@googleapis/calendar';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { computeRecurrenceEndAt } from '../evento/evento.service';
import {
  CalendarSyncJobKind,
  GoogleCalendarConnection,
  GoogleCalendarSource,
  GoogleEventLink,
  GoogleLinkKind,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarSyncEnqueuer } from './calendar-sync.enqueuer';
import { GoogleApiClient, GoogleAuthRevokedError, googleStatus } from './google-api.client';
import {
  eventToGoogle,
  GoogleEvent,
  GoogleInstanceOverride,
  googleInstanceToException,
  googleEventColor,
  googleToEventData,
  PRIVATE_ID_KEY,
  PRIVATE_KIND_KEY,
  RemoteInstanceData,
  taskToGoogle,
} from './google-calendar-mapper';
import { GoogleCalendarConnectionService } from './google-calendar-connection.service';
import { BACKFILL_PAST_DAYS, GoogleCalendarConfig } from './google-calendar.config';
import { decideRemoteChange, isWritableAccessRole, shouldPush } from './sync-rules';
import {
  isItemSyncable,
  SyncEligibilityService,
  UserEligibility,
} from './sync-eligibility.service';

/** Marca, no Google, eventos importados — reconhece a origem ao reatar (Q19). */
const PRIVATE_ORIGIN_KEY = 'taskdyOrigin';

interface SyncContext {
  conn: GoogleCalendarConnection;
  api: calendar_v3.Calendar;
  elig: UserEligibility;
}

type LinkWithSource = GoogleEventLink & { source: GoogleCalendarSource };

interface PushOptions {
  /** Ignora a supressão de eco (reverter, conflito ganho pelo TaskDY). */
  force?: boolean;
  /** O evento sumiu do Google: descarta o vínculo e cria de novo. */
  recreate?: boolean;
}

const eventInclude = {
  exceptions: true,
  attendees: { select: { userId: true, status: true } },
  workspace: { select: { companyId: true } },
} satisfies Prisma.CalendarEventInclude;

type EventRow = Prisma.CalendarEventGetPayload<{ include: typeof eventInclude }>;

/**
 * Motor da sincronização. Tudo aqui roda no worker (outbox), nunca no request.
 *
 * - push: deixa o Google igual ao estado desejado do item para aquele usuário
 *   (cria, atualiza ou remove — um único job cobre as três).
 * - pull: aplica as mudanças do Google (syncToken) com as regras de conflito (Q8),
 *   elegibilidade (Q17/Q18) e somente-leitura (Q7/Q10).
 */
@Injectable()
export class CalendarSyncService {
  private readonly cfg: GoogleCalendarConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleApiClient,
    private readonly eligibility: SyncEligibilityService,
    private readonly enqueuer: CalendarSyncEnqueuer,
    private readonly connections: GoogleCalendarConnectionService,
    config: ConfigService,
    @InjectPinoLogger(CalendarSyncService.name)
    private readonly logger: PinoLogger,
  ) {
    this.cfg = new GoogleCalendarConfig(config);
  }

  async runJob(job: { userId: string; kind: CalendarSyncJobKind; refId: string }): Promise<void> {
    const ctx = await this.contextFor(job.userId);
    if (!ctx) return; // desconectado no meio do caminho — nada a fazer
    try {
      switch (job.kind) {
        case 'push_event':
          return await this.pushEvent(ctx, job.refId);
        case 'push_task':
          return await this.pushTask(ctx, job.refId);
        case 'pull_source':
          await this.pullSource(ctx, job.refId);
          return;
        case 'full_resync':
          return await this.fullResync(ctx);
      }
    } catch (err) {
      if (err instanceof GoogleAuthRevokedError) {
        await this.connections.markRevoked(job.userId);
        return;
      }
      throw err;
    }
  }

  private async contextFor(userId: string): Promise<SyncContext | null> {
    const conn = await this.prisma.googleCalendarConnection.findUnique({ where: { userId } });
    if (!conn || conn.status !== 'active' || !conn.refreshTokenEnc) return null;
    return {
      conn,
      api: this.google.calendarFor(conn),
      elig: await this.eligibility.forUser(userId),
    };
  }

  // ── Push: evento ───────────────────────────────────────────────────────────────

  async pushEvent(ctx: SyncContext, eventId: string, opts: PushOptions = {}): Promise<void> {
    const { conn, elig } = ctx;
    const userId = conn.userId;
    const ev = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      include: eventInclude,
    });
    let link = await this.findLink(conn.id, 'event', eventId);

    const attendee = ev?.attendees.find((a) => a.userId === userId);
    const entitled =
      !!ev &&
      !ev.deletedAt &&
      (ev.ownerId === userId || (!!attendee && attendee.status !== 'declined'));

    if (!ev || !entitled) {
      if (link) await this.removeRemote(ctx, link);
      return;
    }
    if (!isItemSyncable(eventCompanyId(ev), elig)) return; // congelado (Q18)

    const writableSource = !link || isWritableAccessRole(link.source.accessRole);
    const readOnly = ev.ownerId !== userId || ev.externalReadOnly || !writableSource;

    // Evento vindo do Google sem tradução/permissão: o Google é a fonte, nada a enviar.
    if (link && link.origin === 'google' && (ev.externalReadOnly || !writableSource)) {
      if (link.readOnly !== readOnly) {
        await this.prisma.googleEventLink.update({ where: { id: link.id }, data: { readOnly } });
      }
      return;
    }

    if (link && opts.recreate) {
      await this.prisma.googleEventLink.delete({ where: { id: link.id } });
      link = null;
    }

    if (
      !shouldPush({
        force: !!opts.force,
        hasLink: !!link,
        localUpdatedAt: ev.updatedAt,
        linkLocalUpdatedAt: link?.localUpdatedAt ?? null,
        linkReadOnly: link?.readOnly ?? false,
        readOnly,
      })
    ) {
      return;
    }

    const payload = eventToGoogle({
      ...ev,
      companyId: eventCompanyId(ev),
      exceptions: ev.exceptions,
    });

    let saved: GoogleEvent | null = null;
    let source: GoogleCalendarSource | null = link?.source ?? null;

    if (link) {
      const calendarId = link.source.googleCalendarId;
      const googleEventId = link.googleEventId;
      try {
        // If-Match: se o Google mudou desde o último sync, quem decide é o pull (Q8).
        const headers = !opts.force && link.etag ? { 'If-Match': link.etag } : undefined;
        const res =
          link.origin === 'google'
            ? await this.google.call(() =>
                ctx.api.events.patch(
                  {
                    calendarId,
                    eventId: googleEventId,
                    sendUpdates: 'none',
                    requestBody: googleOriginPatch(payload.master, eventId),
                  },
                  { headers },
                ),
              )
            : await this.google.call(() =>
                ctx.api.events.update(
                  {
                    calendarId,
                    eventId: googleEventId,
                    sendUpdates: 'none',
                    requestBody: payload.master,
                  },
                  { headers },
                ),
              );
        saved = res.data;
      } catch (err) {
        const status = googleStatus(err);
        if (status === 412) {
          await this.enqueuer.enqueue(userId, 'pull_source', link.sourceId);
          return;
        }
        if (status === 404 || status === 410) {
          if (link.origin === 'google') {
            // Sumiu no Google: o pull decide (remove localmente).
            await this.enqueuer.enqueue(userId, 'pull_source', link.sourceId);
            return;
          }
          await this.prisma.googleEventLink.delete({ where: { id: link.id } });
          link = null;
        } else {
          throw err;
        }
      }
    }

    if (!saved) {
      source = await this.taskdySource(ctx);
      saved = await this.insertOrReattach(ctx, source, eventId, payload.master);
    }
    if (!saved?.id || !source) return;

    if (payload.overrides.length > 0) {
      await this.pushOverrides(ctx, source.googleCalendarId, saved.id, payload.overrides);
      // Instâncias podem mudar o etag da série; grava o final para não virar "conflito".
      saved =
        (
          await this.google.call(() =>
            ctx.api.events.get({ calendarId: source.googleCalendarId, eventId: saved!.id! }),
          )
        ).data ?? saved;
    }

    await this.saveLink(ctx, {
      source,
      googleEventId: saved.id!,
      kind: 'event',
      localId: eventId,
      etag: saved.etag ?? null,
      googleUpdatedAt: saved.updated ? new Date(saved.updated) : null,
      localUpdatedAt: ev.updatedAt,
      readOnly,
      origin: link?.origin ?? 'taskdy',
    });
  }

  private async pushOverrides(
    ctx: SyncContext,
    calendarId: string,
    masterId: string,
    overrides: GoogleInstanceOverride[],
  ): Promise<void> {
    for (const o of overrides) {
      try {
        await this.google.call(() =>
          ctx.api.events.update({
            calendarId,
            eventId: `${masterId}_${o.instanceSuffix}`,
            sendUpdates: 'none',
            requestBody: { ...o.body, recurringEventId: masterId },
          }),
        );
      } catch (err) {
        if (err instanceof GoogleAuthRevokedError) throw err;
        this.logger.warn(
          { masterId, instance: o.instanceSuffix, status: googleStatus(err) },
          'Falha ao enviar ocorrência alterada — seguindo',
        );
      }
    }
  }

  // ── Push: tarefa ───────────────────────────────────────────────────────────────

  async pushTask(ctx: SyncContext, taskId: string, opts: PushOptions = {}): Promise<void> {
    const { conn, elig } = ctx;
    const userId = conn.userId;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        column: { select: { isDone: true } },
        project: {
          select: {
            id: true,
            workspaceId: true,
            deletedAt: true,
            workspace: { select: { companyId: true, deletedAt: true } },
          },
        },
        taskAssignees: { select: { userId: true } },
      },
    });
    let link = await this.findLink(conn.id, 'task', taskId);

    // Q11: só onde o usuário é responsável e há prazo; sai se excluída/desatribuída.
    const entitled =
      !!task &&
      !task.deletedAt &&
      !task.project.deletedAt &&
      !task.project.workspace.deletedAt &&
      !!task.dueDate &&
      task.taskAssignees.some((a) => a.userId === userId);

    if (!task || !entitled || !task.dueDate) {
      if (link) await this.removeRemote(ctx, link);
      return;
    }
    if (!isItemSyncable(task.project.workspace.companyId, elig)) return;

    if (link && opts.recreate) {
      await this.prisma.googleEventLink.delete({ where: { id: link.id } });
      link = null;
    }
    if (
      !shouldPush({
        force: !!opts.force,
        hasLink: !!link,
        localUpdatedAt: task.updatedAt,
        linkLocalUpdatedAt: link?.localUpdatedAt ?? null,
        linkReadOnly: link?.readOnly ?? true,
        readOnly: true,
      })
    ) {
      return;
    }

    const body = taskToGoogle({
      id: task.id,
      title: task.title,
      startDate: task.startDate,
      dueDate: task.dueDate,
      allDay: task.allDay,
      timezone: task.timezone,
      isDone: task.column.isDone,
      url: `${this.cfg.frontendUrl}/workspace/${task.project.workspaceId}/projetos/${task.project.id}?task=${task.id}`,
    });

    let saved: GoogleEvent | null = null;
    let source: GoogleCalendarSource | null = link?.source ?? null;
    if (link) {
      const calendarId = link.source.googleCalendarId;
      const googleEventId = link.googleEventId;
      try {
        // Sem If-Match: tarefa é somente-leitura no Google, o TaskDY sempre vence (Q2).
        const res = await this.google.call(() =>
          ctx.api.events.update({
            calendarId,
            eventId: googleEventId,
            sendUpdates: 'none',
            requestBody: body,
          }),
        );
        saved = res.data;
      } catch (err) {
        const status = googleStatus(err);
        if (status !== 404 && status !== 410) throw err;
        await this.prisma.googleEventLink.delete({ where: { id: link.id } });
      }
    }
    if (!saved) {
      source = await this.taskdySource(ctx);
      saved = await this.insertOrReattach(ctx, source, taskId, body);
    }
    if (!saved?.id || !source) return;

    await this.saveLink(ctx, {
      source,
      googleEventId: saved.id,
      kind: 'task',
      localId: taskId,
      etag: saved.etag ?? null,
      googleUpdatedAt: saved.updated ? new Date(saved.updated) : null,
      localUpdatedAt: task.updatedAt,
      readOnly: true,
      origin: 'taskdy',
    });
  }

  // ── Push: helpers ──────────────────────────────────────────────────────────────

  private async findLink(
    connectionId: string,
    kind: GoogleLinkKind,
    localId: string,
  ): Promise<LinkWithSource | null> {
    return this.prisma.googleEventLink.findUnique({
      where:
        kind === 'event'
          ? { connectionId_calendarEventId: { connectionId, calendarEventId: localId } }
          : { connectionId_taskId: { connectionId, taskId: localId } },
      include: { source: true },
    });
  }

  private async taskdySource(ctx: SyncContext): Promise<GoogleCalendarSource> {
    const find = () =>
      this.prisma.googleCalendarSource.findFirst({
        where: { connectionId: ctx.conn.id, isTaskdyCalendar: true },
      });
    let source = await find();
    if (!source) {
      await this.connections.setupCalendars(ctx.conn, ctx.api);
      source = await find();
    }
    if (!source) throw new Error('Calendário TaskDY indisponível na conta Google');
    return source;
  }

  /**
   * Antes de criar, procura no calendário TaskDY um evento com o mesmo `taskdyId`
   * (reconexão, link perdido): reaproveita em vez de duplicar (Q19).
   */
  private async insertOrReattach(
    ctx: SyncContext,
    source: GoogleCalendarSource,
    localId: string,
    body: GoogleEvent,
  ): Promise<GoogleEvent> {
    const calendarId = source.googleCalendarId;
    const found = await this.google.call(() =>
      ctx.api.events.list({
        calendarId,
        privateExtendedProperty: [`${PRIVATE_ID_KEY}=${localId}`],
        showDeleted: false,
        maxResults: 5,
      }),
    );
    const existing = found.data.items?.find((e) => !e.recurringEventId && e.id);
    if (existing?.id) {
      const res = await this.google.call(() =>
        ctx.api.events.update({
          calendarId,
          eventId: existing.id!,
          sendUpdates: 'none',
          requestBody: body,
        }),
      );
      return res.data;
    }
    const res = await this.google.call(() =>
      ctx.api.events.insert({ calendarId, sendUpdates: 'none', requestBody: body }),
    );
    return res.data;
  }

  private async saveLink(
    ctx: SyncContext,
    l: {
      source: GoogleCalendarSource;
      googleEventId: string;
      kind: GoogleLinkKind;
      localId: string;
      etag: string | null;
      googleUpdatedAt: Date | null;
      localUpdatedAt: Date;
      readOnly: boolean;
      origin: 'taskdy' | 'google';
    },
  ): Promise<void> {
    const connectionId = ctx.conn.id;
    const localKey = l.kind === 'event' ? { calendarEventId: l.localId } : { taskId: l.localId };
    // Um evento do Google só pode estar ligado a um item: solta vínculo velho que
    // apontasse para ele (reatar após perda de estado).
    await this.prisma.googleEventLink.deleteMany({
      where: { sourceId: l.source.id, googleEventId: l.googleEventId, NOT: localKey },
    });
    const data = {
      sourceId: l.source.id,
      googleEventId: l.googleEventId,
      etag: l.etag,
      googleUpdatedAt: l.googleUpdatedAt,
      localUpdatedAt: l.localUpdatedAt,
      readOnly: l.readOnly,
    };
    await this.prisma.googleEventLink.upsert({
      where:
        l.kind === 'event'
          ? { connectionId_calendarEventId: { connectionId, calendarEventId: l.localId } }
          : { connectionId_taskId: { connectionId, taskId: l.localId } },
      create: { connectionId, kind: l.kind, origin: l.origin, ...localKey, ...data },
      update: data,
    });
  }

  /** Tira a cópia do Google e o vínculo. 404/410/403 = já não está lá / não é nossa. */
  private async removeRemote(ctx: SyncContext, link: LinkWithSource): Promise<void> {
    if (link.origin === 'taskdy' || isWritableAccessRole(link.source.accessRole)) {
      try {
        await this.google.call(() =>
          ctx.api.events.delete({
            calendarId: link.source.googleCalendarId,
            eventId: link.googleEventId,
            sendUpdates: 'none',
          }),
        );
      } catch (err) {
        const status = googleStatus(err);
        if (status !== 404 && status !== 410 && status !== 403) throw err;
      }
    }
    await this.prisma.googleEventLink.deleteMany({ where: { id: link.id } });
  }

  // ── Pull ───────────────────────────────────────────────────────────────────────

  /** Devolve os ids de evento vistos (na leitura completa, é o retrato da janela). */
  async pullSource(
    ctx: SyncContext,
    sourceId: string,
    opts: { full?: boolean } = {},
  ): Promise<Set<string> | null> {
    const source = await this.prisma.googleCalendarSource.findFirst({
      where: { id: sourceId, connectionId: ctx.conn.id },
    });
    if (!source || (!source.isTaskdyCalendar && !source.importEnabled)) return null;

    let listed: { items: GoogleEvent[]; nextSyncToken: string | null };
    try {
      listed = await this.listChanges(ctx, source, opts.full ? null : source.syncToken);
    } catch (err) {
      const status = googleStatus(err);
      if (status === 410 && source.syncToken) {
        // syncToken expirado: relê a janela inteira (Q22).
        listed = await this.listChanges(ctx, source, null);
      } else if (status === 404) {
        await this.handleMissingCalendar(ctx, source);
        return null;
      } else {
        throw err;
      }
    }

    // Séries antes das instâncias, para que a instância ache o vínculo da série.
    const items = [...listed.items].sort(
      (a, b) => Number(!!a.recurringEventId) - Number(!!b.recurringEventId),
    );
    for (const g of items) {
      try {
        await this.applyRemote(ctx, source, g);
      } catch (err) {
        if (err instanceof GoogleAuthRevokedError) throw err;
        this.logger.warn(
          { sourceId, googleEventId: g.id, err: (err as Error).message },
          'Falha ao aplicar mudança do Google — seguindo',
        );
      }
    }

    const now = new Date();
    await this.prisma.googleCalendarSource.update({
      where: { id: source.id },
      data: { syncToken: listed.nextSyncToken ?? source.syncToken, lastPulledAt: now },
    });
    await this.prisma.googleCalendarConnection.update({
      where: { id: ctx.conn.id },
      data: { lastSyncAt: now, lastError: null },
    });
    this.logger.debug(
      { userId: ctx.conn.userId, sourceId, changes: items.length, full: !source.syncToken },
      'Calendário do Google lido',
    );
    return new Set(items.flatMap((g) => (g.id && !g.recurringEventId ? [g.id] : [])));
  }

  /**
   * Checagem ao vivo antes de escrever no TaskDY: o snapshot do contexto pode ter
   * minutos (full resync longo) e a empresa pode ter sido suspensa no meio.
   */
  private async stillSyncable(ctx: SyncContext, companyId: string | null): Promise<boolean> {
    if (!isItemSyncable(companyId, ctx.elig)) return false;
    if (!companyId) return true;
    return this.eligibility.isCompanyEligible(companyId);
  }

  /**
   * Itens vinculados que sumiram do Google sem o pull ter aplicado — típico de
   * exclusão feita enquanto a empresa estava congelada (o syncToken passou por cima).
   * Confirma um a um e aplica como exclusão remota.
   */
  private async reconcileMissing(
    ctx: SyncContext,
    seenBySource: Map<string, Set<string>>,
    eventIds: Set<string>,
    taskIds: Set<string>,
  ): Promise<void> {
    const links = await this.prisma.googleEventLink.findMany({
      where: {
        connectionId: ctx.conn.id,
        sourceId: { in: [...seenBySource.keys()] },
        OR: [{ calendarEventId: { in: [...eventIds] } }, { taskId: { in: [...taskIds] } }],
      },
      include: { source: true },
    });
    for (const link of links) {
      if (seenBySource.get(link.sourceId)?.has(link.googleEventId)) continue;
      let remote: GoogleEvent | null = null;
      try {
        remote = (
          await this.google.call(() =>
            ctx.api.events.get({
              calendarId: link.source.googleCalendarId,
              eventId: link.googleEventId,
            }),
          )
        ).data;
      } catch (err) {
        const status = googleStatus(err);
        if (status !== 404 && status !== 410) throw err;
      }
      // Existe (só estava fora da janela listada): nada a reconciliar.
      if (remote && remote.status !== 'cancelled') continue;
      const gone: GoogleEvent = { id: link.googleEventId, status: 'cancelled' };
      if (link.kind === 'task') await this.applyRemoteTask(ctx, link, gone);
      else await this.applyRemoteEvent(ctx, link.source, link, gone);
    }
  }

  private async listChanges(
    ctx: SyncContext,
    source: GoogleCalendarSource,
    syncToken: string | null,
  ): Promise<{ items: GoogleEvent[]; nextSyncToken: string | null }> {
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    const timeMin = new Date(Date.now() - BACKFILL_PAST_DAYS * 86_400_000).toISOString();
    do {
      const res = await this.google.call(() =>
        ctx.api.events.list(
          syncToken
            ? {
                calendarId: source.googleCalendarId,
                syncToken,
                showDeleted: true,
                maxResults: 250,
                pageToken,
              }
            : {
                calendarId: source.googleCalendarId,
                timeMin,
                singleEvents: false,
                showDeleted: false,
                maxResults: 250,
                pageToken,
              },
        ),
      );
      items.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
      nextSyncToken = res.data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  private async handleMissingCalendar(ctx: SyncContext, source: GoogleCalendarSource) {
    this.logger.warn(
      { userId: ctx.conn.userId, sourceId: source.id, isTaskdy: source.isTaskdyCalendar },
      'Calendário não existe mais no Google',
    );
    await this.prisma.googleCalendarSource.delete({ where: { id: source.id } });
    if (source.isTaskdyCalendar) {
      // Apagaram o "TaskDY": recria e reenvia tudo.
      await this.prisma.googleCalendarConnection.update({
        where: { id: ctx.conn.id },
        data: { taskdyCalendarId: null },
      });
      await this.enqueuer.enqueue(ctx.conn.userId, 'full_resync');
    }
  }

  private async applyRemote(ctx: SyncContext, source: GoogleCalendarSource, g: GoogleEvent) {
    if (!g.id) return;
    if (g.eventType === 'workingLocation') return; // "onde estou trabalhando" não é compromisso
    if (g.recurringEventId) return this.applyRemoteInstance(ctx, source, g);

    let link: LinkWithSource | null = await this.prisma.googleEventLink.findUnique({
      where: { sourceId_googleEventId: { sourceId: source.id, googleEventId: g.id } },
      include: { source: true },
    });

    const priv = g.extendedProperties?.private ?? {};
    const taskdyId = priv[PRIVATE_ID_KEY];
    const kind = priv[PRIVATE_KIND_KEY];
    if (!link && taskdyId && (kind === 'event' || kind === 'task') && g.status !== 'cancelled') {
      link = await this.reattach(ctx, source, g, taskdyId, kind, priv[PRIVATE_ORIGIN_KEY]);
      if (!link) return;
    }
    if (!link) return this.importNew(ctx, source, g);
    if (link.kind === 'task') return this.applyRemoteTask(ctx, link, g);
    return this.applyRemoteEvent(ctx, source, link, g);
  }

  /** Evento do Google com `taskdyId` e sem vínculo: liga ao item existente (Q19). */
  private async reattach(
    ctx: SyncContext,
    source: GoogleCalendarSource,
    g: GoogleEvent,
    localId: string,
    kind: 'event' | 'task',
    originMark: string | undefined,
  ): Promise<LinkWithSource | null> {
    const userId = ctx.conn.userId;
    const deleteThisCopy = async () => {
      if (!source.isTaskdyCalendar && !isWritableAccessRole(source.accessRole)) return;
      try {
        await this.google.call(() =>
          ctx.api.events.delete({
            calendarId: source.googleCalendarId,
            eventId: g.id!,
            sendUpdates: 'none',
          }),
        );
      } catch (err) {
        const status = googleStatus(err);
        if (status !== 404 && status !== 410 && status !== 403) throw err;
      }
    };

    let entitled = false;
    let readOnly = true;
    let isOwner = false;
    if (kind === 'event') {
      const ev = await this.prisma.calendarEvent.findUnique({
        where: { id: localId },
        include: { attendees: { select: { userId: true, status: true } } },
      });
      isOwner = !!ev && ev.ownerId === userId;
      entitled =
        !!ev &&
        !ev.deletedAt &&
        (isOwner || ev.attendees.some((a) => a.userId === userId && a.status !== 'declined'));
      readOnly =
        !ev ||
        ev.ownerId !== userId ||
        ev.externalReadOnly ||
        !isWritableAccessRole(source.accessRole);
    } else {
      const task = await this.prisma.task.findUnique({
        where: { id: localId },
        select: { deletedAt: true, taskAssignees: { select: { userId: true } } },
      });
      entitled = !!task && !task.deletedAt && task.taskAssignees.some((a) => a.userId === userId);
    }

    // Item apagado no TaskDY (ou que o usuário não vê mais): some do Google também.
    if (!entitled) {
      await deleteThisCopy();
      return null;
    }

    const existing = await this.findLink(ctx.conn.id, kind, localId);
    if (existing && existing.googleEventId !== g.id) {
      // Já temos outra cópia ligada: esta é duplicata (ex.: restos de outra conexão).
      if (source.isTaskdyCalendar) await deleteThisCopy();
      return null;
    }

    const created = await this.prisma.googleEventLink.create({
      data: {
        connectionId: ctx.conn.id,
        sourceId: source.id,
        googleEventId: g.id!,
        kind,
        ...(kind === 'event' ? { calendarEventId: localId } : { taskId: localId }),
        // Sem etag/localUpdatedAt: a primeira decisão é só pela última edição.
        etag: null,
        localUpdatedAt: null,
        readOnly,
        // O marcador de origem é propriedade privada que o próprio usuário pode escrever:
        // só vale para evento DELE (senão um convidado forjaria "google" e editaria o
        // evento de outra pessoa).
        origin: originMark === 'google' && isOwner ? 'google' : 'taskdy',
      },
      include: { source: true },
    });
    this.logger.info({ userId, kind, localId, googleEventId: g.id }, 'Item reatado ao Google');
    return created;
  }

  /** Evento criado no Google → evento pessoal do usuário (Q5). */
  private async importNew(ctx: SyncContext, source: GoogleCalendarSource, g: GoogleEvent) {
    if (g.status === 'cancelled') return;
    if (!ctx.elig.personalAllowed) return; // congelado: o full resync diário pega depois
    const mapping = googleToEventData(g, source.timeZone);
    if (!mapping) return;
    const { data } = mapping;
    const writable = isWritableAccessRole(source.accessRole);

    const ev = await this.prisma.calendarEvent.create({
      data: {
        ownerId: ctx.conn.userId,
        title: data.title,
        description: data.description,
        location: data.location,
        color: googleEventColor(g, source.color),
        allDay: data.allDay,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        timezone: data.timezone,
        rrule: data.rrule,
        recurrenceEndAt: data.rrule
          ? computeRecurrenceEndAt(data.rrule, data.startsAt.toISOString(), data.timezone)
          : null,
        externalReadOnly: !mapping.mappable || !writable,
        ...(data.cancelledDates.length > 0 && {
          exceptions: {
            create: data.cancelledDates.map((originalDate) => ({
              originalDate,
              isCancelled: true,
            })),
          },
        }),
      },
    });

    let etag = g.etag ?? null;
    let updated = g.updated ?? null;
    if (writable) {
      // Marca o evento com o id do TaskDY: reconexão sem duplicar (Q19).
      try {
        const res = await this.google.call(() =>
          ctx.api.events.patch({
            calendarId: source.googleCalendarId,
            eventId: g.id!,
            sendUpdates: 'none',
            requestBody: {
              extendedProperties: {
                private: {
                  [PRIVATE_ID_KEY]: ev.id,
                  [PRIVATE_KIND_KEY]: 'event',
                  [PRIVATE_ORIGIN_KEY]: 'google',
                },
              },
            },
          }),
        );
        etag = res.data.etag ?? etag;
        updated = res.data.updated ?? updated;
      } catch (err) {
        if (err instanceof GoogleAuthRevokedError) throw err;
        this.logger.debug(
          { googleEventId: g.id, status: googleStatus(err) },
          'Sem marcar taskdyId',
        );
      }
    }

    await this.prisma.googleEventLink.create({
      data: {
        connectionId: ctx.conn.id,
        sourceId: source.id,
        googleEventId: g.id!,
        kind: 'event',
        calendarEventId: ev.id,
        etag,
        googleUpdatedAt: updated ? new Date(updated) : null,
        localUpdatedAt: ev.updatedAt,
        readOnly: ev.externalReadOnly,
        origin: 'google',
      },
    });
    this.logger.info(
      {
        userId: ctx.conn.userId,
        eventId: ev.id,
        sourceId: source.id,
        readOnly: ev.externalReadOnly,
      },
      'Evento do Google importado como pessoal',
    );
  }

  /** Tarefa é somente-leitura no Google: qualquer mudança lá é desfeita (Q2). */
  private async applyRemoteTask(ctx: SyncContext, link: LinkWithSource, g: GoogleEvent) {
    if (!link.taskId) return;
    const cancelled = g.status === 'cancelled';
    if (!cancelled && g.etag && g.etag === link.etag) return;
    await this.pushTask(ctx, link.taskId, { force: true, recreate: cancelled });
  }

  private async applyRemoteEvent(
    ctx: SyncContext,
    source: GoogleCalendarSource,
    link: LinkWithSource,
    g: GoogleEvent,
  ) {
    const eventId = link.calendarEventId;
    if (!eventId) return;
    const userId = ctx.conn.userId;
    const ev = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      include: eventInclude,
    });
    if (!ev || ev.deletedAt) {
      // Apagado no TaskDY: o push remove do Google.
      await this.pushEvent(ctx, eventId);
      return;
    }

    const frozen = !(await this.stillSyncable(ctx, eventCompanyId(ev)));
    // Quem não é dono nunca edita pelo Google, qualquer que seja a origem do vínculo.
    // Evento de origem Google do próprio dono: o Google é a fonte.
    const readOnly =
      ev.ownerId !== userId || (link.origin === 'taskdy' && (link.readOnly || ev.externalReadOnly));

    if (g.status === 'cancelled') {
      if (frozen) return;
      if (readOnly) {
        if (link.origin === 'taskdy') {
          await this.pushEvent(ctx, eventId, { force: true, recreate: true });
        } else {
          await this.prisma.googleEventLink.delete({ where: { id: link.id } });
        }
        return;
      }
      await this.prisma.calendarEvent.update({
        where: { id: eventId },
        data: { deletedAt: new Date() },
      });
      await this.prisma.googleEventLink.delete({ where: { id: link.id } });
      this.logger.info({ userId, eventId }, 'Evento apagado no Google — apagado no TaskDY');
      await this.enqueuer.enqueueForEvent(eventId); // some da agenda dos convidados
      return;
    }

    const decision = decideRemoteChange({
      remoteEtag: g.etag,
      linkEtag: link.etag,
      frozen,
      readOnly,
      localUpdatedAt: ev.updatedAt,
      linkLocalUpdatedAt: link.localUpdatedAt,
      remoteUpdated: g.updated ? new Date(g.updated) : null,
    });
    if (decision === 'echo' || decision === 'ignore_frozen') return;
    if (decision === 'revert' || decision === 'push_local') {
      await this.pushEvent(ctx, eventId, { force: true });
      return;
    }

    const mapping = googleToEventData(g, source.timeZone);
    if (!mapping) return;
    if (!mapping.mappable && link.origin === 'taskdy') {
      // Recorrência que o TaskDY não representa num evento dele: mantém a versão local.
      await this.pushEvent(ctx, eventId, { force: true });
      return;
    }
    const { data } = mapping;

    await this.prisma.$transaction([
      ...data.cancelledDates.map((originalDate) =>
        this.prisma.calendarEventException.upsert({
          where: { eventId_originalDate: { eventId, originalDate } },
          create: { eventId, originalDate, isCancelled: true },
          update: { isCancelled: true },
        }),
      ),
      // Ocorrência "descancelada" no Google volta a existir.
      this.prisma.calendarEventException.deleteMany({
        where: {
          eventId,
          isCancelled: true,
          originalDate: { notIn: data.cancelledDates },
          overrideTitle: null,
          overrideStartsAt: null,
        },
      }),
    ]);

    const updated = await this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: {
        title: data.title,
        description: data.description,
        location: data.location,
        allDay: data.allDay,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        timezone: data.timezone,
        rrule: data.rrule,
        recurrenceEndAt: data.rrule
          ? computeRecurrenceEndAt(data.rrule, data.startsAt.toISOString(), data.timezone)
          : null,
        ...(link.origin === 'google' && {
          // A cor de evento do Google é do Google; evento criado no TaskDY mantém a dele.
          color: googleEventColor(g, source.color),
          externalReadOnly: !mapping.mappable || !isWritableAccessRole(source.accessRole),
        }),
      },
    });

    await this.prisma.googleEventLink.update({
      where: { id: link.id },
      data: {
        etag: g.etag ?? null,
        googleUpdatedAt: g.updated ? new Date(g.updated) : null,
        localUpdatedAt: updated.updatedAt,
      },
    });
    this.logger.info({ userId, eventId }, 'Mudança do Google aplicada no TaskDY');
    await this.enqueuer.enqueueForEvent(eventId); // cópias dos convidados
  }

  /** Ocorrência alterada/cancelada no Google → exceção da série no TaskDY. */
  private async applyRemoteInstance(
    ctx: SyncContext,
    source: GoogleCalendarSource,
    g: GoogleEvent,
  ) {
    const link = await this.prisma.googleEventLink.findUnique({
      where: {
        sourceId_googleEventId: { sourceId: source.id, googleEventId: g.recurringEventId! },
      },
    });
    if (!link?.calendarEventId) return;
    const eventId = link.calendarEventId;
    const ev = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      include: eventInclude,
    });
    if (!ev || ev.deletedAt || !ev.rrule) return;
    if (!(await this.stillSyncable(ctx, eventCompanyId(ev)))) return;

    const raw = googleInstanceToException(g, ev);
    if (!raw) return;
    const data = normalizeInstance(raw, ev);
    const current = ev.exceptions.find(
      (e) => e.originalDate.getTime() === data.originalDate.getTime(),
    );
    if (sameException(current, data)) return; // eco do nosso próprio push

    const readOnly =
      ev.ownerId !== ctx.conn.userId ||
      (link.origin === 'taskdy' && (link.readOnly || ev.externalReadOnly));
    if (readOnly) {
      await this.revertInstance(ctx, source, link.googleEventId, g, ev, current);
      return;
    }

    await this.prisma.calendarEventException.upsert({
      where: { eventId_originalDate: { eventId, originalDate: data.originalDate } },
      create: { eventId, ...data },
      update: data,
    });
    // Toca a série: é o `updatedAt` dela que dispara o push para os convidados.
    const touched = await this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: { updatedAt: new Date() },
    });
    await this.prisma.googleEventLink.update({
      where: { id: link.id },
      data: { localUpdatedAt: touched.updatedAt },
    });
    await this.enqueuer.enqueueForEvent(eventId);
  }

  /** Desfaz no Google a alteração de uma ocorrência que o usuário não pode editar. */
  private async revertInstance(
    ctx: SyncContext,
    source: GoogleCalendarSource,
    masterGoogleId: string,
    g: GoogleEvent,
    ev: EventRow,
    local: EventRow['exceptions'][number] | undefined,
  ) {
    const payload = eventToGoogle({ ...ev, companyId: eventCompanyId(ev) });
    const override = payload.overrides.find(
      (o) => local && o.originalDate.getTime() === local.originalDate.getTime(),
    );
    if (local?.isCancelled) {
      // Localmente a ocorrência não existe: a série reenviada leva o EXDATE.
      await this.pushEvent(ctx, ev.id, { force: true });
      return;
    }
    const occStart = local?.originalDate ?? googleInstanceToException(g, ev)?.originalDate;
    if (!occStart) return;
    const body: GoogleEvent = override?.body ?? {
      summary: payload.master.summary,
      description: payload.master.description,
      location: payload.master.location,
      ...eventToGoogle({
        ...ev,
        rrule: null,
        startsAt: occStart,
        endsAt: new Date(occStart.getTime() + (ev.endsAt.getTime() - ev.startsAt.getTime())),
        companyId: eventCompanyId(ev),
        exceptions: [],
      }).master,
      recurrence: undefined,
      extendedProperties: undefined,
    };
    try {
      await this.google.call(() =>
        ctx.api.events.update({
          calendarId: source.googleCalendarId,
          eventId: g.id!,
          sendUpdates: 'none',
          requestBody: {
            ...body,
            status: 'confirmed',
            recurringEventId: masterGoogleId,
            originalStartTime: g.originalStartTime,
          },
        }),
      );
    } catch (err) {
      if (err instanceof GoogleAuthRevokedError) throw err;
      this.logger.warn(
        { eventId: ev.id, status: googleStatus(err) },
        'Falha ao reverter ocorrência',
      );
    }
  }

  // ── Full resync ────────────────────────────────────────────────────────────────

  /**
   * Backfill e reconciliação (connect, reconexão, diário): relê os calendários
   * inteiros na janela (Q22) e garante que tudo que o usuário deveria ter está no
   * Google. Idempotente — também reconcilia empresa que voltou a ser elegível (Q18).
   */
  async fullResync(ctx: SyncContext): Promise<void> {
    const userId = ctx.conn.userId;
    await this.connections.setupCalendars(ctx.conn, ctx.api);

    const sources = await this.prisma.googleCalendarSource.findMany({
      where: {
        connectionId: ctx.conn.id,
        OR: [{ isTaskdyCalendar: true }, { importEnabled: true }],
      },
    });
    const seenBySource = new Map<string, Set<string>>();
    for (const s of sources) {
      const seen = await this.pullSource(ctx, s.id, { full: true });
      if (seen) seenBySource.set(s.id, seen);
    }

    const windowStart = new Date(Date.now() - BACKFILL_PAST_DAYS * 86_400_000);
    const [events, tasks, links] = await Promise.all([
      this.prisma.calendarEvent.findMany({
        where: {
          deletedAt: null,
          AND: [
            { OR: [{ ownerId: userId }, { attendees: { some: { userId } } }] },
            {
              OR: [
                { rrule: null, endsAt: { gte: windowStart } },
                {
                  rrule: { not: null },
                  OR: [{ recurrenceEndAt: null }, { recurrenceEndAt: { gte: windowStart } }],
                },
              ],
            },
          ],
        },
        select: { id: true },
      }),
      this.prisma.task.findMany({
        where: {
          deletedAt: null,
          dueDate: { gte: windowStart },
          taskAssignees: { some: { userId } },
        },
        select: { id: true },
      }),
      this.prisma.googleEventLink.findMany({
        where: { connectionId: ctx.conn.id },
        select: { calendarEventId: true, taskId: true },
      }),
    ]);

    const eventIds = new Set([
      ...events.map((e) => e.id),
      ...links.flatMap((l) => (l.calendarEventId ? [l.calendarEventId] : [])),
    ]);
    const taskIds = new Set([
      ...tasks.map((t) => t.id),
      ...links.flatMap((l) => (l.taskId ? [l.taskId] : [])),
    ]);

    let failures = 0;
    const each = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof GoogleAuthRevokedError) throw err;
        failures++;
        this.logger.warn({ userId, err: (err as Error).message }, 'Falha num item do resync');
      }
    };
    await each(() => this.reconcileMissing(ctx, seenBySource, eventIds, taskIds));
    for (const id of eventIds) await each(() => this.pushEvent(ctx, id));
    for (const id of taskIds) await each(() => this.pushTask(ctx, id));

    await this.prisma.googleCalendarConnection.update({
      where: { id: ctx.conn.id },
      data: {
        lastSyncAt: new Date(),
        lastError:
          failures > 0 ? `${failures} item(ns) não sincronizaram; nova tentativa em breve.` : null,
      },
    });
    this.logger.info(
      { userId, events: eventIds.size, tasks: taskIds.size, failures },
      'Resync completo com o Google',
    );
  }
}

function eventCompanyId(ev: { companyId: string | null; workspace: { companyId: string } | null }) {
  return ev.companyId ?? ev.workspace?.companyId ?? null;
}

/** Patch para evento de origem Google: não impõe visibilidade/lembretes do TaskDY. */
function googleOriginPatch(master: GoogleEvent, localId: string): GoogleEvent {
  return {
    summary: master.summary,
    description: master.description,
    location: master.location,
    start: master.start,
    end: master.end,
    recurrence: master.recurrence,
    extendedProperties: {
      private: {
        [PRIVATE_ID_KEY]: localId,
        [PRIVATE_KIND_KEY]: 'event',
        [PRIVATE_ORIGIN_KEY]: 'google',
      },
    },
  };
}

/** Campo igual ao da série vira null — é assim que o TaskDY guarda "sem override". */
function normalizeInstance(d: RemoteInstanceData, ev: EventRow): RemoteInstanceData {
  if (d.isCancelled) return d;
  const duration = ev.endsAt.getTime() - ev.startsAt.getTime();
  const start = d.overrideStartsAt ?? d.originalDate;
  return {
    ...d,
    overrideTitle: d.overrideTitle === ev.title ? null : d.overrideTitle,
    overrideDescription:
      (d.overrideDescription ?? null) === (ev.description ?? null) ? null : d.overrideDescription,
    overrideLocation:
      (d.overrideLocation ?? null) === (ev.location ?? null) ? null : d.overrideLocation,
    overrideStartsAt:
      d.overrideStartsAt?.getTime() === d.originalDate.getTime() ? null : d.overrideStartsAt,
    overrideEndsAt:
      d.overrideEndsAt?.getTime() === start.getTime() + duration ? null : d.overrideEndsAt,
  };
}

function sameException(
  cur:
    | {
        isCancelled: boolean;
        overrideTitle: string | null;
        overrideDescription: string | null;
        overrideLocation: string | null;
        overrideStartsAt: Date | null;
        overrideEndsAt: Date | null;
      }
    | undefined,
  d: RemoteInstanceData,
): boolean {
  if (!cur) {
    return (
      !d.isCancelled &&
      !d.overrideTitle &&
      !d.overrideDescription &&
      !d.overrideLocation &&
      !d.overrideStartsAt &&
      !d.overrideEndsAt
    );
  }
  if (cur.isCancelled || d.isCancelled) return cur.isCancelled === d.isCancelled;
  return (
    (cur.overrideTitle ?? null) === (d.overrideTitle ?? null) &&
    (cur.overrideDescription ?? null) === (d.overrideDescription ?? null) &&
    (cur.overrideLocation ?? null) === (d.overrideLocation ?? null) &&
    (cur.overrideStartsAt?.getTime() ?? null) === (d.overrideStartsAt?.getTime() ?? null) &&
    (cur.overrideEndsAt?.getTime() ?? null) === (d.overrideEndsAt?.getTime() ?? null)
  );
}
