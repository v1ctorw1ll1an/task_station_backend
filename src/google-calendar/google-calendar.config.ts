import { ConfigService } from '@nestjs/config';

/** Escopo da agenda: o usuário pode desmarcá-lo na tela granular de consentimento. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** Escopos pedidos no consentimento: agenda completa + identidade da conta. */
export const GOOGLE_SCOPES = [GOOGLE_CALENDAR_SCOPE, 'openid', 'email'] as const;

/** Nome do calendário dedicado criado na conta Google (Q3). */
export const TASKDY_CALENDAR_SUMMARY = 'TaskDY';

/** Janela do backfill (Q22): últimos 30 dias + futuro. */
export const BACKFILL_PAST_DAYS = 30;

/**
 * Leitura centralizada das envs da integração. A feature fica desligada até o app ser
 * verificado pelo Google (Q12): `GOOGLE_CALENDAR_ENABLED=true` liga e
 * `GOOGLE_CALENDAR_ALLOWLIST` (e-mails, vírgula) restringe a quem é testador.
 */
export class GoogleCalendarConfig {
  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return (
      this.config.get<string>('GOOGLE_CALENDAR_ENABLED') === 'true' &&
      !!this.clientId &&
      !!this.clientSecret &&
      !!this.redirectUri &&
      !!this.config.get<string>('GOOGLE_TOKEN_ENC_KEY')
    );
  }

  get clientId(): string {
    return this.config.get<string>('GOOGLE_CLIENT_ID') ?? '';
  }

  get clientSecret(): string {
    return this.config.get<string>('GOOGLE_CLIENT_SECRET') ?? '';
  }

  get redirectUri(): string {
    return this.config.get<string>('GOOGLE_REDIRECT_URI') ?? '';
  }

  /** Vazio em dev: sem webhook, o cron puxa as mudanças (Q13). */
  get webhookUrl(): string {
    return this.config.get<string>('GOOGLE_WEBHOOK_URL')?.trim() ?? '';
  }

  get frontendUrl(): string {
    return (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '');
  }

  /** Lista vazia = sem restrição (app já verificado). */
  get allowlist(): string[] {
    return (this.config.get<string>('GOOGLE_CALENDAR_ALLOWLIST') ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }

  isAllowed(email: string): boolean {
    const list = this.allowlist;
    return list.length === 0 || list.includes(email.trim().toLowerCase());
  }
}
