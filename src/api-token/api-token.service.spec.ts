import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PinoLogger } from 'nestjs-pino';
import { API_TOKEN } from '../common/limits';
import { ApiTokenRepository } from './api-token.repository';
import { ApiTokenService } from './api-token.service';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeRepo(over: Partial<Record<keyof ApiTokenRepository, jest.Mock>> = {}) {
  return {
    findActiveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1', name: 'WS', companyId: 'c-1' }),
    hasWorkspaceAccess: jest.fn().mockResolvedValue(true),
    createWithinLimit: jest
      .fn()
      .mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve({ id: 'tok-1', name: data.name, prefix: data.prefix }),
      ),
    listByUser: jest.fn().mockResolvedValue([]),
    revoke: jest.fn().mockResolvedValue({ count: 1 }),
    findByHash: jest.fn().mockResolvedValue(null),
    touchLastUsed: jest.fn().mockResolvedValue({}),
    findCurrent: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

function makeService(repo = makeRepo(), logger = makeLogger()) {
  return {
    service: new ApiTokenService(
      repo as unknown as ApiTokenRepository,
      logger as unknown as PinoLogger,
    ),
    repo,
    logger,
  };
}

const VALID_RECORD = () => ({
  id: 'tok-1',
  workspaceId: 'ws-1',
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  lastUsedAt: null as Date | null,
  user: {
    id: 'u-1',
    email: 'a@x.com',
    isActive: true,
    deletedAt: null as Date | null,
    mustResetPassword: false,
    // A integração é só de superusuário: o token de quem não é não vale.
    isSuperuser: true,
  },
  workspace: {
    deletedAt: null as Date | null,
    isActive: true,
    company: { deletedAt: null as Date | null, isActive: true },
  },
});

// ── create ─────────────────────────────────────────────────────────────────────

describe('ApiTokenService.create', () => {
  it('gera tdy_ + 256 bits e guarda só o hash', async () => {
    const { service, repo } = makeService();

    const result = await service.create('u-1', { name: '  Claude  ', workspaceId: 'ws-1' });

    expect(result.token).toMatch(/^tdy_[A-Za-z0-9_-]{43}$/);
    const data = repo.createWithinLimit.mock.calls[0][0] as Record<string, unknown>;
    expect(data.tokenHash).toBe(sha256(result.token));
    expect(JSON.stringify(data)).not.toContain(result.token);
    expect(data.prefix).toBe(result.token.slice(0, 12));
    expect(data.name).toBe('Claude');
  });

  it('validade padrão e personalizada', async () => {
    const { service, repo } = makeService();
    const before = Date.now();

    await service.create('u-1', { name: 'a', workspaceId: 'ws-1' });
    await service.create('u-1', { name: 'b', workspaceId: 'ws-1', expiresInDays: 7 });

    const days = (i: number) =>
      ((repo.createWithinLimit.mock.calls[i][0] as { expiresAt: Date }).expiresAt.getTime() -
        before) /
      86_400_000;
    expect(Math.round(days(0))).toBe(API_TOKEN.defaultDays);
    expect(Math.round(days(1))).toBe(7);
  });

  it('workspace inexistente → 404', async () => {
    const { service } = makeService(
      makeRepo({ findActiveWorkspace: jest.fn().mockResolvedValue(null) }),
    );
    await expect(service.create('u-1', { name: 'a', workspaceId: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('quem não é membro do workspace não cria token → 403', async () => {
    const { service, repo } = makeService(
      makeRepo({ hasWorkspaceAccess: jest.fn().mockResolvedValue(false) }),
    );
    await expect(service.create('u-1', { name: 'a', workspaceId: 'ws-1' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.createWithinLimit).not.toHaveBeenCalled();
  });

  it(`limite de ${API_TOKEN.maxActivePerUser} tokens ativos → 400`, async () => {
    const { service, repo } = makeService(
      makeRepo({ createWithinLimit: jest.fn().mockResolvedValue(null) }),
    );
    await expect(service.create('u-1', { name: 'a', workspaceId: 'ws-1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // O teto é conferido dentro do lock do repository, não antes (corrida).
    expect(repo.createWithinLimit).toHaveBeenCalledWith(
      expect.any(Object),
      API_TOKEN.maxActivePerUser,
      expect.any(Date),
    );
  });

  it('nunca loga o token em claro', async () => {
    const { service, logger } = makeService();
    const { token } = await service.create('u-1', { name: 'a', workspaceId: 'ws-1' });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).not.toContain(token);
  });
});

// ── revoke ─────────────────────────────────────────────────────────────────────

describe('ApiTokenService.revoke', () => {
  it('revoga só token do próprio usuário', async () => {
    const { service, repo } = makeService();
    await service.revoke('u-1', 'tok-1');
    expect(repo.revoke).toHaveBeenCalledWith('u-1', 'tok-1', expect.any(Date));
  });

  it('token de outro usuário ou já revogado → 404', async () => {
    const { service } = makeService(
      makeRepo({ revoke: jest.fn().mockResolvedValue({ count: 0 }) }),
    );
    await expect(service.revoke('u-1', 'tok-x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── authenticate ───────────────────────────────────────────────────────────────

describe('ApiTokenService.authenticate', () => {
  const RAW = 'tdy_' + 'a'.repeat(43);

  it('token válido devolve AuthUser e o escopo do token', async () => {
    const repo = makeRepo({ findByHash: jest.fn().mockResolvedValue(VALID_RECORD()) });
    const { service } = makeService(repo);

    await expect(service.authenticate(RAW)).resolves.toEqual({
      user: { id: 'u-1', email: 'a@x.com', isSuperuser: false, mustResetPassword: false },
      token: { id: 'tok-1', workspaceId: 'ws-1' },
    });
    expect(repo.findByHash).toHaveBeenCalledWith(sha256(RAW));
  });

  it('nunca carrega poder de superusuário, mesmo o dono sendo um', async () => {
    const { service } = makeService(
      makeRepo({ findByHash: jest.fn().mockResolvedValue(VALID_RECORD()) }),
    );
    const { user } = await service.authenticate(RAW);
    expect(user.isSuperuser).toBe(false);
  });

  it.each([
    ['desconhecido', null],
    ['revogado', { ...VALID_RECORD(), revokedAt: new Date() }],
    ['expirado', { ...VALID_RECORD(), expiresAt: new Date(Date.now() - 1) }],
    [
      'de usuário desativado',
      { ...VALID_RECORD(), user: { ...VALID_RECORD().user, isActive: false } },
    ],
    [
      'de usuário excluído',
      { ...VALID_RECORD(), user: { ...VALID_RECORD().user, deletedAt: new Date() } },
    ],
    [
      'de dono que deixou de ser superusuário',
      { ...VALID_RECORD(), user: { ...VALID_RECORD().user, isSuperuser: false } },
    ],
    [
      'de workspace excluído',
      { ...VALID_RECORD(), workspace: { ...VALID_RECORD().workspace, deletedAt: new Date() } },
    ],
    [
      'de workspace inativo',
      { ...VALID_RECORD(), workspace: { ...VALID_RECORD().workspace, isActive: false } },
    ],
    [
      'de empresa excluída',
      {
        ...VALID_RECORD(),
        workspace: {
          ...VALID_RECORD().workspace,
          company: { deletedAt: new Date(), isActive: true },
        },
      },
    ],
    [
      'de empresa desativada',
      {
        ...VALID_RECORD(),
        workspace: { ...VALID_RECORD().workspace, company: { deletedAt: null, isActive: false } },
      },
    ],
  ])('token %s → 401 API_TOKEN_INVALID', async (_caso, record) => {
    const { service } = makeService(makeRepo({ findByHash: jest.fn().mockResolvedValue(record) }));
    const err = await service.authenticate(RAW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      code: 'API_TOKEN_INVALID',
    });
  });

  it('sem prefixo ou grande demais nem vai ao banco', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await expect(service.authenticate('abc')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.authenticate('tdy_' + 'x'.repeat(200))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repo.findByHash).not.toHaveBeenCalled();
  });

  it('grava lastUsedAt no máximo uma vez por minuto', async () => {
    const usedNow = { ...VALID_RECORD(), lastUsedAt: new Date() };
    const usedLongAgo = { ...VALID_RECORD(), lastUsedAt: new Date(Date.now() - 120_000) };
    const repo = makeRepo({
      findByHash: jest.fn().mockResolvedValueOnce(usedNow).mockResolvedValueOnce(usedLongAgo),
    });
    const { service } = makeService(repo);

    await service.authenticate(RAW);
    expect(repo.touchLastUsed).not.toHaveBeenCalled();

    await service.authenticate(RAW);
    expect(repo.touchLastUsed).toHaveBeenCalledWith('tok-1', expect.any(Date));
  });

  it('falha ao gravar lastUsedAt não derruba a request', async () => {
    const repo = makeRepo({
      findByHash: jest.fn().mockResolvedValue(VALID_RECORD()),
      touchLastUsed: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const { service, logger } = makeService(repo);

    await expect(service.authenticate(RAW)).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── describeCurrent ────────────────────────────────────────────────────────────

describe('ApiTokenService.describeCurrent', () => {
  const user = { id: 'u-1', email: 'a@x.com', isSuperuser: false, mustResetPassword: false };
  const current = {
    id: 'tok-1',
    name: 'Claude',
    expiresAt: new Date(),
    user: { id: 'u-1', name: 'Ana', email: 'a@x.com' },
    workspace: { id: 'ws-1', name: 'Produto', companyId: 'c-1', company: { legalName: 'ACME' } },
  };

  it('devolve workspace e usuário do token', async () => {
    const { service } = makeService(
      makeRepo({ findCurrent: jest.fn().mockResolvedValue(current) }),
    );
    await expect(
      service.describeCurrent({ id: 'tok-1', workspaceId: 'ws-1' }, user),
    ).resolves.toMatchObject({
      tokenId: 'tok-1',
      workspace: { id: 'ws-1', name: 'Produto', companyName: 'ACME' },
    });
  });

  it('quem saiu do workspace não vê nem o nome dele → 403', async () => {
    const { service } = makeService(
      makeRepo({
        findCurrent: jest.fn().mockResolvedValue(current),
        hasWorkspaceAccess: jest.fn().mockResolvedValue(false),
      }),
    );
    await expect(
      service.describeCurrent({ id: 'tok-1', workspaceId: 'ws-1' }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ── listEligibleWorkspaces ─────────────────────────────────────────────────────

describe('ApiTokenService.listEligibleWorkspaces', () => {
  it('achata a empresa no item, para o seletor da tela', async () => {
    const findEligibleWorkspaces = jest
      .fn()
      .mockResolvedValue([
        { id: 'ws-1', name: 'Produto', company: { id: 'c-1', legalName: 'ACME' } },
      ]);
    const { service } = makeService(makeRepo({ findEligibleWorkspaces }));

    await expect(service.listEligibleWorkspaces('u-1')).resolves.toEqual([
      { id: 'ws-1', name: 'Produto', companyId: 'c-1', companyName: 'ACME' },
    ]);
    expect(findEligibleWorkspaces).toHaveBeenCalledWith('u-1');
  });
});
