import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService } from './mailer.service';

// ── mock resend ────────────────────────────────────────────────────────────────

const sendMock = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => sendMock(...args) },
  })),
}));

// ── helpers ────────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    RESEND_API_KEY: 're_test_key',
    MAILER_FROM: 'TaskDY <noreply@example.com>',
    FRONTEND_URL: 'http://localhost:3000',
    ...overrides,
  };
  return {
    get: jest.fn(<T = string>(key: string, def?: T) => (values[key] as T) ?? def),
    getOrThrow: jest.fn(<T = string>(key: string) => {
      if (values[key] === undefined) throw new Error(`Missing ${key}`);
      return values[key] as T;
    }),
  } as unknown as ConfigService;
}

function makeService(config: ConfigService = makeConfig()) {
  const logger = makeLogger();
  return { service: new MailerService(config, logger as any), logger };
}

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
});

// ── constructor ────────────────────────────────────────────────────────────────

describe('MailerService.constructor', () => {
  it('lança erro quando RESEND_API_KEY está ausente', () => {
    const config = makeConfig();
    (config.getOrThrow as jest.Mock).mockImplementation(() => {
      throw new Error('Missing RESEND_API_KEY');
    });
    expect(() => new MailerService(config, makeLogger() as any)).toThrow('Missing RESEND_API_KEY');
  });

  it('usa MAILER_FROM default quando não configurado', () => {
    const values: Record<string, string> = { RESEND_API_KEY: 're_x' };
    const config = {
      get: jest.fn((key: string, def?: string) => values[key] ?? def),
      getOrThrow: jest.fn((key: string) => {
        if (!values[key]) throw new Error('missing');
        return values[key];
      }),
    } as unknown as ConfigService;

    expect(() => new MailerService(config, makeLogger() as any)).not.toThrow();
    expect(config.get).toHaveBeenCalledWith(
      'MAILER_FROM',
      'TaskDY <noreply@contato.taskstation.manyflux.com.br>',
    );
  });
});

// ── sendPasswordResetEmail ─────────────────────────────────────────────────────

describe('MailerService.sendPasswordResetEmail', () => {
  it('envia email com from/to/subject/html/text corretos', async () => {
    const { service } = makeService();

    await service.sendPasswordResetEmail('user@example.com', 'https://app/reset?token=abc');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.from).toBe('TaskDY <noreply@example.com>');
    expect(payload.to).toBe('user@example.com');
    expect(payload.subject).toBe('Redefinição de senha — TaskDY');
    expect(payload.html).toContain('https://app/reset?token=abc');
    expect(payload.text).toContain('https://app/reset?token=abc');
  });

  it('lança InternalServerErrorException e loga erro quando provider falha', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'rate_limit', message: 'too many' } });
    const { service, logger } = makeService();

    await expect(
      service.sendPasswordResetEmail('user@example.com', 'https://x'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@example.com', errorCode: 'rate_limit' }),
      'Failed to send password reset email',
    );
  });

  it('loga info em caso de sucesso', async () => {
    const { service, logger } = makeService();
    await service.sendPasswordResetEmail('u@x.com', 'https://x');
    expect(logger.info).toHaveBeenCalledWith(
      { to: 'u@x.com' },
      expect.stringContaining('Password reset'),
    );
  });
});

// ── sendWelcomeEmail ───────────────────────────────────────────────────────────

describe('MailerService.sendWelcomeEmail', () => {
  it('inclui nome, email e senha temporária no corpo', async () => {
    const { service } = makeService();
    await service.sendWelcomeEmail('new@example.com', 'Alice', 'tempPwd123');

    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toContain('Bem-vindo');
    expect(payload.html).toContain('Alice');
    expect(payload.html).toContain('new@example.com');
    expect(payload.html).toContain('tempPwd123');
  });

  it('usa FRONTEND_URL no link de acesso', async () => {
    const { service } = makeService(makeConfig({ FRONTEND_URL: 'https://taskdy.app' }));
    await service.sendWelcomeEmail('new@x.com', 'Bob', 'pwd');

    const payload = sendMock.mock.calls[0][0];
    expect(payload.html).toContain('https://taskdy.app/login');
  });

  it('lança quando provider retorna error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'unknown', message: 'boom' } });
    const { service } = makeService();
    await expect(service.sendWelcomeEmail('a@b.com', 'X', 'p')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

// ── sendEventNotificationEmail ─────────────────────────────────────────────────

describe('MailerService.sendEventNotificationEmail', () => {
  const baseParams = {
    to: 'attendee@example.com',
    title: 'Sprint Planning',
    startsAt: new Date('2026-05-15T13:00:00Z'),
    endsAt: new Date('2026-05-15T14:00:00Z'),
    location: 'Sala 3',
    description: 'Pauta\nDetalhes',
    timezone: 'America/Sao_Paulo',
    organizerName: 'Alice',
  };

  it('monta subject "Novo evento" para kind=created', async () => {
    const { service } = makeService();
    await service.sendEventNotificationEmail({ ...baseParams, kind: 'created' });

    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toBe('Novo evento: Sprint Planning');
    expect(payload.html).toContain('Sala 3');
    expect(payload.html).toContain('Pauta<br/>Detalhes');
    expect(payload.html).toContain('Alice');
  });

  it('monta subject "Evento atualizado" para kind=updated', async () => {
    const { service } = makeService();
    await service.sendEventNotificationEmail({ ...baseParams, kind: 'updated' });
    expect(sendMock.mock.calls[0][0].subject).toBe('Evento atualizado: Sprint Planning');
  });

  it('omite datas/local/descrição quando kind=cancelled', async () => {
    const { service } = makeService();
    await service.sendEventNotificationEmail({ ...baseParams, kind: 'cancelled' });

    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toBe('Evento cancelado: Sprint Planning');
    expect(payload.html).not.toContain('Sala 3');
    expect(payload.html).not.toContain('Início:');
  });

  it('NÃO lança quando provider falha (apenas loga)', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'soft', message: 'fail' } });
    const { service, logger } = makeService();

    await expect(
      service.sendEventNotificationEmail({ ...baseParams, kind: 'created' }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });

  it('omite linha de organizador quando organizerName é null', async () => {
    const { service } = makeService();
    await service.sendEventNotificationEmail({
      ...baseParams,
      kind: 'created',
      organizerName: null,
    });
    expect(sendMock.mock.calls[0][0].html).not.toContain('Organizador:');
  });
});

// ── sendEventReminderEmail ─────────────────────────────────────────────────────

describe('MailerService.sendEventReminderEmail', () => {
  const base = {
    to: 'a@x.com',
    title: 'Daily',
    startsAt: new Date('2026-05-15T13:00:00Z'),
    endsAt: new Date('2026-05-15T13:15:00Z'),
    location: null,
    description: null,
    timezone: 'America/Sao_Paulo',
  };

  it('formata minutesBefore < 60 em minutos', async () => {
    const { service } = makeService();
    await service.sendEventReminderEmail({ ...base, minutesBefore: 15 });
    expect(sendMock.mock.calls[0][0].subject).toBe('Lembrete: Daily (em 15 minutos)');
  });

  it('formata minutesBefore >= 60 em horas', async () => {
    const { service } = makeService();
    await service.sendEventReminderEmail({ ...base, minutesBefore: 120 });
    expect(sendMock.mock.calls[0][0].subject).toBe('Lembrete: Daily (em 2 hora(s))');
  });

  it('formata minutesBefore >= 1440 em dias', async () => {
    const { service } = makeService();
    await service.sendEventReminderEmail({ ...base, minutesBefore: 2880 });
    expect(sendMock.mock.calls[0][0].subject).toBe('Lembrete: Daily (em 2 dia(s))');
  });

  it('lança InternalServerErrorException quando provider falha', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'x', message: 'y' } });
    const { service } = makeService();
    await expect(
      service.sendEventReminderEmail({ ...base, minutesBefore: 10 }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

// ── sendFirstAccessEmail ───────────────────────────────────────────────────────

describe('MailerService.sendFirstAccessEmail', () => {
  it('inclui nome e magic link no corpo', async () => {
    const { service } = makeService();
    await service.sendFirstAccessEmail('new@example.com', 'Charlie', 'https://app/magic/abc');

    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toContain('Bem-vindo');
    expect(payload.html).toContain('Charlie');
    expect(payload.html).toContain('https://app/magic/abc');
    expect(payload.text).toContain('https://app/magic/abc');
  });

  it('lança quando provider falha', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'x', message: 'y' } });
    const { service } = makeService();
    await expect(service.sendFirstAccessEmail('a@b.com', 'X', 'https://l')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
