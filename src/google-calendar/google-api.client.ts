import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { calendar, calendar_v3 } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { GOOGLE_SCOPES, GoogleCalendarConfig } from './google-calendar.config';
import { TokenCipher } from './token-crypto';

/** O Google invalidou o refresh token (revogado, senha trocada, app removido). */
export class GoogleAuthRevokedError extends Error {
  constructor(message = 'Acesso ao Google revogado') {
    super(message);
    this.name = 'GoogleAuthRevokedError';
  }
}

export interface ConnectionCredentials {
  id: string;
  refreshTokenEnc: string | null;
  accessTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
}

export interface ExchangedTokens {
  refreshToken: string | null;
  accessToken: string | null;
  expiresAt: Date | null;
  googleAccountId: string;
  email: string;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const MAX_RETRIES = 3;

/**
 * Wrapper fino do `@googleapis/calendar`: credenciais por conexão com refresh
 * automático (o token novo é gravado cifrado), backoff em limite de taxa e tradução
 * de `invalid_grant` para `GoogleAuthRevokedError`.
 */
@Injectable()
export class GoogleApiClient {
  private readonly cfg: GoogleCalendarConfig;
  private cipherInstance: TokenCipher | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(GoogleApiClient.name)
    private readonly logger: PinoLogger,
  ) {
    this.cfg = new GoogleCalendarConfig(config);
  }

  /** Lazy: sem a chave a feature fica desligada, mas o app sobe. */
  get cipher(): TokenCipher {
    this.cipherInstance ??= new TokenCipher(this.config.get<string>('GOOGLE_TOKEN_ENC_KEY') ?? '');
    return this.cipherInstance;
  }

  private oauthClient(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
      redirectUri: this.cfg.redirectUri,
    });
  }

  buildAuthUrl(state: string): string {
    return this.oauthClient().generateAuthUrl({
      access_type: 'offline',
      // Garante refresh_token mesmo em reconexão.
      prompt: 'consent',
      include_granted_scopes: true,
      scope: [...GOOGLE_SCOPES],
      state,
    });
  }

  async exchangeCode(code: string): Promise<ExchangedTokens> {
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw new Error('Google não devolveu id_token');
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.cfg.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) throw new Error('id_token sem sub/email');
    return {
      refreshToken: tokens.refresh_token ?? null,
      accessToken: tokens.access_token ?? null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      googleAccountId: payload.sub,
      email: payload.email,
    };
  }

  /** Cliente da Calendar API autenticado como a conexão. */
  calendarFor(conn: ConnectionCredentials): calendar_v3.Calendar {
    if (!conn.refreshTokenEnc) throw new GoogleAuthRevokedError('Conexão sem refresh token');
    const client = this.oauthClient();
    client.setCredentials({
      refresh_token: this.cipher.decrypt(conn.refreshTokenEnc),
      access_token: conn.accessTokenEnc ? this.cipher.decrypt(conn.accessTokenEnc) : undefined,
      expiry_date: conn.accessTokenExpiresAt?.getTime(),
    });
    client.on('tokens', (t) => {
      void this.prisma.googleCalendarConnection
        .update({
          where: { id: conn.id },
          data: {
            ...(t.access_token && { accessTokenEnc: this.cipher.encrypt(t.access_token) }),
            ...(t.expiry_date && { accessTokenExpiresAt: new Date(t.expiry_date) }),
            ...(t.refresh_token && { refreshTokenEnc: this.cipher.encrypt(t.refresh_token) }),
          },
        })
        .catch((err: Error) =>
          this.logger.warn({ connectionId: conn.id, err: err.message }, 'Falha ao gravar token'),
        );
    });
    return calendar({ version: 'v3', auth: client });
  }

  /** Revoga no Google (melhor esforço — desconectar não pode falhar por isso). */
  async revoke(conn: ConnectionCredentials): Promise<void> {
    if (!conn.refreshTokenEnc) return;
    try {
      await this.oauthClient().revokeToken(this.cipher.decrypt(conn.refreshTokenEnc));
    } catch (err) {
      this.logger.warn(
        { connectionId: conn.id, err: (err as Error).message },
        'Falha ao revogar token no Google — seguindo com a desconexão',
      );
    }
  }

  /**
   * Executa uma chamada com backoff em 429/403 rateLimit e traduz `invalid_grant`.
   * Demais erros sobem como vieram (use `googleStatus` para inspecionar).
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (isInvalidGrant(err)) throw new GoogleAuthRevokedError();
        if (isRateLimited(err) && attempt < MAX_RETRIES) {
          const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
          this.logger.warn({ attempt, delay }, 'Google rate limit — tentando de novo');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }
}

interface GoogleErrorShape {
  status?: number;
  code?: number | string;
  response?: {
    status?: number;
    data?: { error?: string | { errors?: { reason?: string }[] } };
  };
  errors?: { reason?: string }[];
  message?: string;
}

export function googleStatus(err: unknown): number | undefined {
  const e = err as GoogleErrorShape | null;
  if (!e) return undefined;
  const raw = e.status ?? e.response?.status ?? e.code;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && !Number.isNaN(n) ? n : undefined;
}

export function isInvalidGrant(err: unknown): boolean {
  const e = err as GoogleErrorShape | null;
  if (!e) return false;
  const data = e.response?.data?.error;
  return data === 'invalid_grant' || (e.message ?? '').includes('invalid_grant');
}

function isRateLimited(err: unknown): boolean {
  const status = googleStatus(err);
  if (status === 429) return true;
  if (status !== 403) return false;
  const e = err as GoogleErrorShape;
  const data = e.response?.data?.error;
  const reasons = [
    ...(e.errors ?? []),
    ...(typeof data === 'object' && data?.errors ? data.errors : []),
  ].map((r) => r.reason);
  return reasons.some((r) => r && RATE_LIMIT_REASONS.has(r));
}
