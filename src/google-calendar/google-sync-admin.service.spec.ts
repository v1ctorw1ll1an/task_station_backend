import { ConfigService } from '@nestjs/config';
import { GoogleSyncAdminService } from './google-sync-admin.service';
import { GoogleSyncSettingsService } from './google-sync-settings.service';
import { SyncDirection } from './sync-rules';

const enabledEnv: Record<string, string> = {
  GOOGLE_CALENDAR_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/cb',
  GOOGLE_TOKEN_ENC_KEY: 'k',
};

function setup(opts: { stored?: SyncDirection | null; enabled?: boolean } = {}) {
  let stored = opts.stored ?? null;
  const prisma = {
    googleCalendarSettings: {
      findUnique: jest.fn().mockImplementation(() =>
        Promise.resolve(
          stored
            ? {
                syncDirection: stored,
                updatedAt: new Date('2026-10-19T12:00:00Z'),
                updatedBy: { id: 'su', name: 'Super', email: 'su@x.com' },
              }
            : null,
        ),
      ),
      upsert: jest
        .fn()
        .mockImplementation(({ create }: { create: { syncDirection: SyncDirection } }) => {
          stored = create.syncDirection;
          return Promise.resolve({});
        }),
    },
    googleCalendarConnection: {
      count: jest.fn().mockResolvedValue(2),
      findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
    },
    calendarSyncJob: {
      count: jest
        .fn()
        .mockImplementation((args?: { where?: unknown }) => Promise.resolve(args?.where ? 1 : 5)),
    },
  };
  const config = {
    get: (k: string) => (opts.enabled === false ? undefined : enabledEnv[k]),
  } as unknown as ConfigService;
  const enqueuer = { enqueue: jest.fn() };
  const logger = { info: jest.fn() };
  const settings = new GoogleSyncSettingsService(prisma as never);
  const admin = new GoogleSyncAdminService(
    prisma as never,
    settings,
    enqueuer as never,
    config,
    logger as never,
  );
  return { admin, settings, prisma, enqueuer };
}

describe('GoogleSyncSettingsService (google-calendar)', () => {
  it('sem configuração gravada vale "ambos"', async () => {
    const { settings } = setup();
    expect(await settings.getDirection()).toBe('both');
  });

  it('guarda em cache curto: mutações seguidas não consultam o banco de novo', async () => {
    const { settings, prisma } = setup({ stored: 'google_to_app' });
    expect(await settings.getDirection()).toBe('google_to_app');
    expect(await settings.getDirection()).toBe('google_to_app');
    expect(prisma.googleCalendarSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it('gravar atualiza o cache na hora e devolve a direção anterior', async () => {
    const { settings, prisma } = setup({ stored: 'both' });
    await settings.getDirection();
    expect(await settings.setDirection('app_to_google', 'su')).toBe('both');
    expect(await settings.getDirection()).toBe('app_to_google');
    expect(prisma.googleCalendarSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'global' },
        create: { id: 'global', syncDirection: 'app_to_google', updatedById: 'su' },
      }),
    );
  });
});

describe('GoogleSyncAdminService (google-calendar)', () => {
  it('painel: direção, quem alterou e números de saúde', async () => {
    const { admin } = setup({ stored: 'google_to_app' });
    expect(await admin.getPanel()).toEqual({
      enabled: true,
      direction: 'google_to_app',
      updatedAt: new Date('2026-10-19T12:00:00Z'),
      updatedBy: { id: 'su', name: 'Super', email: 'su@x.com' },
      stats: { activeConnections: 2, pendingJobs: 5, failingJobs: 1 },
    });
  });

  it('trocar a direção agenda resync completo de cada conexão ativa', async () => {
    const { admin, enqueuer } = setup({ stored: 'both' });
    const res = await admin.setDirection('app_to_google', 'su');
    expect(res.direction).toBe('app_to_google');
    expect(res.resyncQueued).toBe(2);
    expect(enqueuer.enqueue).toHaveBeenCalledWith('u1', 'full_resync');
    expect(enqueuer.enqueue).toHaveBeenCalledWith('u2', 'full_resync');
  });

  it('gravar a mesma direção não dispara resync', async () => {
    const { admin, enqueuer } = setup({ stored: 'both' });
    const res = await admin.setDirection('both', 'su');
    expect(res.resyncQueued).toBe(0);
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('integração desligada no servidor: grava, mas não enfileira nada', async () => {
    const { admin, enqueuer } = setup({ stored: 'both', enabled: false });
    const res = await admin.setDirection('google_to_app', 'su');
    expect(res).toMatchObject({ enabled: false, direction: 'google_to_app', resyncQueued: 0 });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });
});
