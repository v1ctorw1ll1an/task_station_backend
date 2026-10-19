import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { calendar_v3 } from '@googleapis/calendar';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  GoogleCalendarConnection,
  GoogleCalendarSource,
  NotificationType,
} from '../generated/prisma/client';
import { NotificacaoService } from '../notificacao/notificacao.service';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarSyncEnqueuer } from './calendar-sync.enqueuer';
import { GoogleApiClient, googleStatus } from './google-api.client';
import { DEFAULT_TZ, googleCalendarColor, TASKDY_CALENDAR_MARKER } from './google-calendar-mapper';
import { GoogleCalendarConfig, TASKDY_CALENDAR_SUMMARY } from './google-calendar.config';
import { GoogleSyncSettingsService } from './google-sync-settings.service';
import { isWritableAccessRole, SyncDirection } from './sync-rules';
import { SyncEligibilityService } from './sync-eligibility.service';
import { sha256 } from './token-crypto';

const STATE_PURPOSE = 'google_calendar_connect';
const STATE_TTL = '10m';
/** Canais do Google duram no máximo ~7 dias; renovamos com 24 h de folga. */
const CHANNEL_TTL_SECONDS = 7 * 24 * 3600;
const CHANNEL_RENEW_MARGIN_MS = 24 * 3600_000;

interface ConnectState {
  sub: string;
  purpose: string;
  nonce: string;
}

export interface GoogleCalendarStatus {
  enabled: boolean;
  allowed: boolean;
  canConnect: boolean;
  /** Direção global definida pelo superusuário. */
  direction: SyncDirection;
  connection: {
    status: string;
    googleEmail: string;
    lastSyncAt: Date | null;
    lastError: string | null;
    connectedAt: Date;
  } | null;
  calendars: {
    id: string;
    summary: string;
    accessRole: string;
    writable: boolean;
    isTaskdyCalendar: boolean;
    importEnabled: boolean;
  }[];
  companies: { companyId: string; name: string; status: string | null; eligible: boolean }[];
}

/**
 * Ciclo de vida da conexão: OAuth (state assinado), calendário dedicado "TaskDY",
 * lista de calendários importáveis, canais de webhook e desconexão.
 */
@Injectable()
export class GoogleCalendarConnectionService {
  private readonly cfg: GoogleCalendarConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleApiClient,
    private readonly eligibility: SyncEligibilityService,
    private readonly enqueuer: CalendarSyncEnqueuer,
    private readonly notificacao: NotificacaoService,
    private readonly jwt: JwtService,
    private readonly settings: GoogleSyncSettingsService,
    config: ConfigService,
    @InjectPinoLogger(GoogleCalendarConnectionService.name)
    private readonly logger: PinoLogger,
  ) {
    this.cfg = new GoogleCalendarConfig(config);
  }

  get config(): GoogleCalendarConfig {
    return this.cfg;
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────────

  private assertAvailable(email: string): void {
    if (!this.cfg.enabled) {
      throw new ServiceUnavailableException('Integração com o Google Agenda indisponível');
    }
    if (!this.cfg.isAllowed(email)) {
      throw new ForbiddenException('Integração com o Google Agenda ainda em teste fechado');
    }
  }

  async buildConnectUrl(userId: string, email: string): Promise<{ url: string }> {
    this.assertAvailable(email);
    const elig = await this.eligibility.forUser(userId);
    if (elig.eligibleIds.size === 0) {
      throw new ForbiddenException(
        'A integração exige ao menos uma empresa com plano ativo (período de teste não conta).',
      );
    }
    const state = await this.jwt.signAsync(
      { sub: userId, purpose: STATE_PURPOSE, nonce: randomUUID() } satisfies ConnectState,
      { expiresIn: STATE_TTL },
    );
    return { url: this.google.buildAuthUrl(state) };
  }

  /**
   * Fecha o OAuth. Chamado pelo front (rota de callback) **autenticado**: o `state`
   * precisa ser do mesmo usuário da sessão — sem isso, um link forjado ligaria a
   * agenda da vítima à conta de quem o forjou.
   */
  async completeConnect(userId: string, email: string, code: string, state: string) {
    this.assertAvailable(email);
    let payload: ConnectState;
    try {
      payload = await this.jwt.verifyAsync<ConnectState>(state);
    } catch {
      throw new BadRequestException('Pedido de conexão expirado. Tente de novo.');
    }
    if (payload.purpose !== STATE_PURPOSE || payload.sub !== userId) {
      throw new ForbiddenException('Pedido de conexão não pertence a esta sessão');
    }
    const elig = await this.eligibility.forUser(userId);
    if (elig.eligibleIds.size === 0) {
      throw new ForbiddenException('Nenhuma empresa com plano elegível para a integração');
    }

    const tokens = await this.google.exchangeCode(code);
    if (!tokens.refreshToken) {
      throw new BadRequestException('O Google não liberou acesso offline. Tente conectar de novo.');
    }

    const existing = await this.prisma.googleCalendarConnection.findUnique({ where: { userId } });
    const sameAccount = existing?.googleAccountId === tokens.googleAccountId;
    if (existing && !sameAccount) {
      // Outra conta Google: os vínculos antigos apontam para outra agenda.
      await this.prisma.googleCalendarSource.deleteMany({ where: { connectionId: existing.id } });
    }

    const cipher = this.google.cipher;
    const tokenData = {
      googleAccountId: tokens.googleAccountId,
      googleEmail: tokens.email,
      refreshTokenEnc: cipher.encrypt(tokens.refreshToken),
      accessTokenEnc: tokens.accessToken ? cipher.encrypt(tokens.accessToken) : null,
      accessTokenExpiresAt: tokens.expiresAt,
      status: 'active' as const,
      lastError: null,
    };
    const conn = await this.prisma.googleCalendarConnection.upsert({
      where: { userId },
      create: { userId, ...tokenData },
      update: { ...tokenData, ...(sameAccount ? {} : { taskdyCalendarId: null }) },
    });

    await this.setupCalendars(conn);
    await this.enqueuer.enqueue(userId, 'full_resync');
    this.logger.info(
      { userId, connectionId: conn.id, reattached: sameAccount },
      'Google Agenda conectado',
    );
    return { googleEmail: tokens.email };
  }

  /** Q15: para de sincronizar e revoga; nada é apagado em nenhum dos lados. */
  async disconnect(userId: string): Promise<void> {
    const conn = await this.prisma.googleCalendarConnection.findUnique({
      where: { userId },
      include: { sources: true },
    });
    if (!conn) return;

    if (conn.status === 'active' && conn.refreshTokenEnc) {
      try {
        const api = this.google.calendarFor(conn);
        for (const s of conn.sources) await this.stopWatch(api, s);
      } catch (err) {
        this.logger.warn({ userId, err: (err as Error).message }, 'Falha ao parar canais');
      }
      await this.google.revoke(conn);
    }
    await this.clearAccess(conn.id, userId, 'revoked', null);
    this.logger.info({ userId, connectionId: conn.id }, 'Google Agenda desconectado');
  }

  /** O Google recusou o refresh token: desliga e avisa o usuário. */
  async markRevoked(userId: string): Promise<void> {
    const conn = await this.prisma.googleCalendarConnection.findUnique({ where: { userId } });
    if (!conn || conn.status === 'revoked') return;
    await this.clearAccess(
      conn.id,
      userId,
      'revoked',
      'O Google revogou o acesso do TaskDY à sua agenda. Conecte de novo.',
    );
    this.logger.warn({ userId, connectionId: conn.id }, 'Acesso ao Google revogado');
    await this.notificacao
      .notify({
        type: NotificationType.INTEGRATION_ALERT,
        recipientId: userId,
        title: 'Google Agenda desconectado',
        body: 'O Google revogou o acesso do TaskDY à sua agenda. Conecte de novo em Perfil › Integrações.',
        metadata: { integration: 'google_calendar' },
      })
      .catch(() => {
        /* aviso é melhor esforço */
      });
  }

  private async clearAccess(
    connectionId: string,
    userId: string,
    status: 'revoked' | 'error',
    lastError: string | null,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.googleCalendarConnection.update({
        where: { id: connectionId },
        data: {
          status,
          lastError,
          refreshTokenEnc: null,
          accessTokenEnc: null,
          accessTokenExpiresAt: null,
        },
      }),
      this.prisma.googleCalendarSource.updateMany({
        where: { connectionId },
        data: {
          syncToken: null,
          channelId: null,
          channelResourceId: null,
          channelTokenHash: null,
          channelExpiresAt: null,
        },
      }),
      this.prisma.calendarSyncJob.deleteMany({ where: { userId } }),
    ]);
  }

  // ── Status / calendários ───────────────────────────────────────────────────────

  async getStatus(userId: string, email: string): Promise<GoogleCalendarStatus> {
    const [conn, elig, direction] = await Promise.all([
      this.prisma.googleCalendarConnection.findUnique({
        where: { userId },
        include: { sources: { orderBy: [{ isTaskdyCalendar: 'desc' }, { summary: 'asc' }] } },
      }),
      this.eligibility.forUser(userId),
      this.settings.getDirection(),
    ]);
    const active = conn?.status === 'active';
    return {
      enabled: this.cfg.enabled,
      allowed: this.cfg.isAllowed(email),
      canConnect: elig.eligibleIds.size > 0,
      direction,
      connection: conn
        ? {
            status: conn.status,
            googleEmail: conn.googleEmail,
            lastSyncAt: conn.lastSyncAt,
            lastError: conn.lastError,
            connectedAt: conn.createdAt,
          }
        : null,
      calendars: active
        ? conn.sources.map((s) => ({
            id: s.id,
            summary: s.summary,
            accessRole: s.accessRole,
            writable: isWritableAccessRole(s.accessRole),
            isTaskdyCalendar: s.isTaskdyCalendar,
            importEnabled: s.isTaskdyCalendar || s.importEnabled,
          }))
        : [],
      companies: elig.companies,
    };
  }

  async updateSources(
    userId: string,
    items: { sourceId: string; importEnabled: boolean }[],
  ): Promise<void> {
    const conn = await this.prisma.googleCalendarConnection.findUnique({ where: { userId } });
    if (!conn || conn.status !== 'active')
      throw new NotFoundException('Google Agenda não conectado');
    const api = this.google.calendarFor(conn);

    for (const item of items) {
      const source = await this.prisma.googleCalendarSource.findFirst({
        where: { id: item.sourceId, connectionId: conn.id, isTaskdyCalendar: false },
      });
      if (!source || source.importEnabled === item.importEnabled) continue;
      const updated = await this.prisma.googleCalendarSource.update({
        where: { id: source.id },
        data: {
          importEnabled: item.importEnabled,
          ...(item.importEnabled ? {} : { syncToken: null }),
        },
      });
      if (item.importEnabled) {
        await this.ensureWatch(api, updated);
        await this.enqueuer.enqueue(userId, 'pull_source', source.id);
      } else {
        // Parar de importar não apaga nada do que já veio (mesma regra do desconectar).
        await this.stopWatch(api, updated);
      }
      this.logger.info(
        { userId, sourceId: source.id, importEnabled: item.importEnabled },
        'Importação de calendário alterada',
      );
    }
  }

  /**
   * Relê a lista de calendários da conta, garante o calendário "TaskDY" e os canais
   * de webhook. Usado no connect e em todo full resync (calendário novo aparece).
   */
  async setupCalendars(
    conn: GoogleCalendarConnection,
    api: calendar_v3.Calendar = this.google.calendarFor(conn),
  ): Promise<void> {
    let list = await this.listCalendars(api);
    const taskdyCalendarId = await this.ensureTaskdyCalendar(conn, api, list);
    if (!list.some((c) => c.id === taskdyCalendarId)) list = await this.listCalendars(api);

    const seen = new Set<string>();
    for (const cal of list) {
      if (!cal.id) continue;
      seen.add(cal.id);
      const isTaskdy = cal.id === taskdyCalendarId;
      const color = googleCalendarColor(cal.backgroundColor);
      const before = await this.prisma.googleCalendarSource.findUnique({
        where: {
          connectionId_googleCalendarId: { connectionId: conn.id, googleCalendarId: cal.id },
        },
        select: { id: true, color: true },
      });
      await this.prisma.googleCalendarSource.upsert({
        where: {
          connectionId_googleCalendarId: { connectionId: conn.id, googleCalendarId: cal.id },
        },
        create: {
          connectionId: conn.id,
          googleCalendarId: cal.id,
          summary: isTaskdy
            ? TASKDY_CALENDAR_SUMMARY
            : (cal.summaryOverride ?? cal.summary ?? cal.id),
          accessRole: cal.accessRole ?? 'reader',
          timeZone: cal.timeZone ?? null,
          color,
          isTaskdyCalendar: isTaskdy,
          importEnabled: isTaskdy,
        },
        update: {
          summary: isTaskdy
            ? TASKDY_CALENDAR_SUMMARY
            : (cal.summaryOverride ?? cal.summary ?? cal.id),
          accessRole: cal.accessRole ?? 'reader',
          timeZone: cal.timeZone ?? null,
          color,
          isTaskdyCalendar: isTaskdy,
          ...(isTaskdy ? { importEnabled: true } : {}),
        },
      });
      if (before) await this.repaintImportedEvents(before.id, before.color, color);
    }

    // Calendário que sumiu da conta (removido/descadastrado): some da lista. Os
    // eventos já importados continuam no TaskDY (vínculos caem em cascata).
    await this.prisma.googleCalendarSource.deleteMany({
      where: { connectionId: conn.id, googleCalendarId: { notIn: [...seen] } },
    });

    const syncable = await this.prisma.googleCalendarSource.findMany({
      where: { connectionId: conn.id, OR: [{ isTaskdyCalendar: true }, { importEnabled: true }] },
    });
    for (const s of syncable) await this.ensureWatch(api, s);
  }

  /**
   * Eventos importados do calendário que ainda estão com a cor dele (ou sem cor —
   * importados antes de a cor existir) acompanham a troca de cor no Google. Evento
   * com `colorId` próprio ou recolorido no TaskDY fica como está.
   */
  private async repaintImportedEvents(
    sourceId: string,
    oldColor: string | null,
    newColor: string | null,
  ): Promise<void> {
    if (!newColor || oldColor === newColor) return;
    const { count } = await this.prisma.calendarEvent.updateMany({
      where: {
        deletedAt: null,
        OR: [{ color: null }, ...(oldColor ? [{ color: oldColor }] : [])],
        googleLinks: { some: { sourceId, origin: 'google' } },
      },
      data: { color: newColor },
    });
    if (count > 0) {
      this.logger.info(
        { sourceId, count },
        'Eventos importados recoloridos com a cor do calendário',
      );
    }
  }

  private async listCalendars(
    api: calendar_v3.Calendar,
  ): Promise<calendar_v3.Schema$CalendarListEntry[]> {
    const out: calendar_v3.Schema$CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.google.call(() =>
        api.calendarList.list({ maxResults: 250, pageToken, showHidden: true }),
      );
      out.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  /** Acha (pelo marcador) ou cria o calendário dedicado — nunca cria dois (Q3/Q19). */
  private async ensureTaskdyCalendar(
    conn: GoogleCalendarConnection,
    api: calendar_v3.Calendar,
    list: calendar_v3.Schema$CalendarListEntry[],
  ): Promise<string> {
    const owned = list.filter((c) => c.accessRole === 'owner' && c.id);
    let id =
      (conn.taskdyCalendarId && owned.find((c) => c.id === conn.taskdyCalendarId)?.id) ||
      owned.find((c) => (c.description ?? '').includes(TASKDY_CALENDAR_MARKER))?.id ||
      null;

    if (!id) {
      const created = await this.google.call(() =>
        api.calendars.insert({
          requestBody: {
            summary: TASKDY_CALENDAR_SUMMARY,
            description: `Eventos e prazos sincronizados pelo TaskDY. ${TASKDY_CALENDAR_MARKER}`,
            timeZone: list.find((c) => c.primary)?.timeZone ?? DEFAULT_TZ,
          },
        }),
      );
      id = created.data.id ?? null;
      if (!id) throw new Error('Google não devolveu o id do calendário criado');
      this.logger.info({ connectionId: conn.id }, 'Calendário TaskDY criado no Google');
    }

    if (conn.taskdyCalendarId && conn.taskdyCalendarId !== id) {
      // O calendário antigo foi apagado no Google: os vínculos dele não valem mais.
      await this.prisma.googleCalendarSource.deleteMany({
        where: { connectionId: conn.id, googleCalendarId: conn.taskdyCalendarId },
      });
    }
    if (conn.taskdyCalendarId !== id) {
      await this.prisma.googleCalendarConnection.update({
        where: { id: conn.id },
        data: { taskdyCalendarId: id },
      });
      conn.taskdyCalendarId = id;
    }
    return id;
  }

  // ── Webhook (events.watch) ─────────────────────────────────────────────────────

  /** Abre (ou renova, se expira em < 24 h) o canal de push do calendário. */
  async ensureWatch(api: calendar_v3.Calendar, source: GoogleCalendarSource): Promise<void> {
    const address = this.cfg.webhookUrl;
    if (!address) return; // dev: só cron (Q13)
    if (
      source.channelId &&
      source.channelExpiresAt &&
      source.channelExpiresAt.getTime() > Date.now() + CHANNEL_RENEW_MARGIN_MS
    ) {
      return;
    }
    await this.stopWatch(api, source);

    const channelId = randomUUID();
    const token = randomBytes(32).toString('hex');
    try {
      const res = await this.google.call(() =>
        api.events.watch({
          calendarId: source.googleCalendarId,
          requestBody: {
            id: channelId,
            type: 'web_hook',
            address,
            token,
            params: { ttl: String(CHANNEL_TTL_SECONDS) },
          },
        }),
      );
      await this.prisma.googleCalendarSource.update({
        where: { id: source.id },
        data: {
          channelId,
          channelResourceId: res.data.resourceId ?? null,
          channelTokenHash: sha256(token),
          channelExpiresAt: res.data.expiration
            ? new Date(Number(res.data.expiration))
            : new Date(Date.now() + CHANNEL_TTL_SECONDS * 1000),
        },
      });
    } catch (err) {
      // Sem canal o cron de reserva continua cobrindo; não derruba o fluxo.
      this.logger.warn(
        { sourceId: source.id, status: googleStatus(err), err: (err as Error).message },
        'Falha ao abrir canal de webhook do Google',
      );
    }
  }

  async stopWatch(api: calendar_v3.Calendar, source: GoogleCalendarSource): Promise<void> {
    if (!source.channelId) return;
    if (source.channelResourceId) {
      try {
        await this.google.call(() =>
          api.channels.stop({
            requestBody: { id: source.channelId, resourceId: source.channelResourceId },
          }),
        );
      } catch (err) {
        this.logger.debug(
          { sourceId: source.id, err: (err as Error).message },
          'channels.stop falhou (canal já expirado?)',
        );
      }
    }
    await this.prisma.googleCalendarSource.update({
      where: { id: source.id },
      data: {
        channelId: null,
        channelResourceId: null,
        channelTokenHash: null,
        channelExpiresAt: null,
      },
    });
  }

  /**
   * Valida a notificação do Google e enfileira a leitura. `unknown` = canal que não
   * é nosso (ou já trocado); `forbidden` = token não confere.
   */
  async handleWebhook(
    channelId: string | undefined,
    token: string | undefined,
    resourceState: string | undefined,
  ): Promise<'ok' | 'unknown' | 'forbidden'> {
    if (!channelId || !token) return 'forbidden';
    const source = await this.prisma.googleCalendarSource.findUnique({
      where: { channelId },
      include: { connection: { select: { userId: true, status: true } } },
    });
    if (!source?.channelTokenHash) return 'unknown';
    // Canal vencido não vale mais, mesmo com o token certo.
    if (source.channelExpiresAt && source.channelExpiresAt.getTime() < Date.now()) return 'unknown';
    const expected = Buffer.from(source.channelTokenHash, 'hex');
    const received = Buffer.from(sha256(token), 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return 'forbidden';
    }
    // "sync" é só o aperto de mão da abertura do canal.
    if (resourceState === 'sync' || source.connection.status !== 'active') return 'ok';
    await this.enqueuer.enqueue(source.connection.userId, 'pull_source', source.id);
    return 'ok';
  }
}
