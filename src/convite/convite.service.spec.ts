import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipRole } from '../generated/prisma/client';
import { ConviteRepository } from './convite.repository';
import { ConviteService } from './convite.service';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeRepo(
  overrides: Partial<Record<keyof ConviteRepository, jest.Mock>> = {},
): jest.Mocked<ConviteRepository> {
  return {
    findCompanyById: jest.fn().mockResolvedValue({ id: 'company-1', legalName: 'Acme Ltda' }),
    findActiveUserByEmail: jest.fn().mockResolvedValue(null),
    findCompanyMembership: jest.fn().mockResolvedValue(null),
    revokePendingForEmail: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'invite-1' }),
    findByTokenHash: jest.fn(),
    findPendingByCompany: jest.fn().mockResolvedValue([]),
    findPendingById: jest.fn(),
    revokeById: jest.fn(),
    accept: jest.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as jest.Mocked<ConviteRepository>;
}

/** Convite válido, com a empresa embutida como o repo devolve. */
function makeInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    companyId: 'company-1',
    email: 'maria@acme.com',
    tokenHash: 'hash',
    role: MembershipRole.member,
    invitedById: 'admin-1',
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
    acceptedById: null,
    revokedAt: null,
    createdAt: new Date(),
    company: { id: 'company-1', legalName: 'Acme Ltda', isActive: true, deletedAt: null },
    ...overrides,
  };
}

function makeService(
  repo: jest.Mocked<ConviteRepository>,
  deps: {
    assertSeatAvailable?: jest.Mock;
    getSummary?: jest.Mock;
    sendCompanyInviteEmail?: jest.Mock;
  } = {},
) {
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = { FRONTEND_URL: 'http://localhost:3000' };
      return map[key] ?? fallback;
    }),
    getOrThrow: jest.fn(() => 'http://localhost:3000'),
  } as unknown as ConfigService;

  const mailerService = {
    sendCompanyInviteEmail: deps.sendCompanyInviteEmail ?? jest.fn().mockResolvedValue(undefined),
  };
  const billingService = {
    assertSeatAvailable: deps.assertSeatAvailable ?? jest.fn().mockResolvedValue(undefined),
  };
  const billingAccess = {
    getSummary: deps.getSummary ?? jest.fn().mockResolvedValue({ mode: 'ok' }),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  return {
    service: new ConviteService(
      repo,
      configService,
      mailerService as any,
      billingService as any,
      billingAccess as any,
      logger as any,
    ),
    mailerService,
    billingService,
    billingAccess,
  };
}

// ── criarConvite ───────────────────────────────────────────────────────────────

describe('ConviteService.criarConvite', () => {
  const base = { companyId: 'company-1', email: '  MARIA@acme.com ', invitedById: 'admin-1' };

  it('normaliza o e-mail, revoga pendentes anteriores e guarda só o hash do token', async () => {
    const repo = makeRepo();
    const { service, mailerService } = makeService(repo);

    const result = await service.criarConvite(base);

    expect(repo.revokePendingForEmail).toHaveBeenCalledWith('company-1', 'maria@acme.com');
    const createArgs = repo.create.mock.calls[0][0];
    expect(createArgs.email).toBe('maria@acme.com');
    expect(createArgs.role).toBe(MembershipRole.member);
    // token cru só existe no link; o banco recebe SHA-256 (64 hex)
    expect(createArgs.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inviteLink).toContain('/convite/');
    expect(result.inviteLink).not.toContain(createArgs.tokenHash);
    expect(result.emailSent).toBe(true);
    expect(mailerService.sendCompanyInviteEmail).toHaveBeenCalledWith(
      'maria@acme.com',
      'Acme Ltda',
      result.inviteLink,
      7,
    );
  });

  it('recusa quando não há assento livre — antes de gravar qualquer convite', async () => {
    const repo = makeRepo();
    const assertSeatAvailable = jest.fn().mockRejectedValue(new BadRequestException('sem assento'));
    const { service } = makeService(repo, { assertSeatAvailable });

    await expect(service.criarConvite(base)).rejects.toThrow(BadRequestException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('recusa convite para quem já é membro da empresa', async () => {
    const repo = makeRepo({
      findActiveUserByEmail: jest.fn().mockResolvedValue({ id: 'user-1' }),
      findCompanyMembership: jest.fn().mockResolvedValue({ id: 'membership-1' }),
    });
    const { service } = makeService(repo);

    await expect(service.criarConvite(base)).rejects.toThrow(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('convite é criado mesmo se o e-mail falhar — o link volta para envio manual', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo, {
      sendCompanyInviteEmail: jest.fn().mockRejectedValue(new Error('smtp down')),
    });

    const result = await service.criarConvite(base);

    expect(repo.create).toHaveBeenCalled();
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toContain('/convite/');
  });
});

// ── preview ────────────────────────────────────────────────────────────────────

describe('ConviteService.preview', () => {
  it('token inexistente → not_found sem vazar nada', async () => {
    const repo = makeRepo({ findByTokenHash: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.preview('qualquer')).resolves.toEqual({
      status: 'not_found',
      companyName: null,
      email: null,
    });
  });

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['accepted', { acceptedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('reporta status %s', async (status, overrides) => {
    const repo = makeRepo({
      findByTokenHash: jest.fn().mockResolvedValue(makeInvite(overrides)),
    });
    const { service } = makeService(repo);

    await expect(service.preview('tok')).resolves.toEqual({
      status,
      companyName: 'Acme Ltda',
      email: 'maria@acme.com',
    });
  });

  it('convite bom → valid com nome da empresa', async () => {
    const repo = makeRepo({ findByTokenHash: jest.fn().mockResolvedValue(makeInvite()) });
    const { service } = makeService(repo);

    await expect(service.preview('tok')).resolves.toEqual({
      status: 'valid',
      companyName: 'Acme Ltda',
      email: 'maria@acme.com',
    });
  });
});

// ── aceitar ────────────────────────────────────────────────────────────────────

describe('ConviteService.aceitar', () => {
  const maria = { id: 'user-1', email: 'maria@acme.com' };

  it('recusa convite de outro e-mail (link repassado não dá acesso)', async () => {
    const repo = makeRepo({ findByTokenHash: jest.fn().mockResolvedValue(makeInvite()) });
    const { service } = makeService(repo);

    await expect(service.aceitar('tok', { id: 'user-2', email: 'joao@acme.com' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it.each([
    ['revogado', { revokedAt: new Date() }],
    ['já aceito', { acceptedAt: new Date() }],
    ['expirado', { expiresAt: new Date(Date.now() - 1000) }],
  ])('recusa convite %s', async (_nome, overrides) => {
    const repo = makeRepo({
      findByTokenHash: jest.fn().mockResolvedValue(makeInvite(overrides)),
    });
    const { service } = makeService(repo);

    await expect(service.aceitar('tok', maria)).rejects.toThrow(BadRequestException);
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it('recusa quando a empresa está suspensa', async () => {
    const repo = makeRepo({ findByTokenHash: jest.fn().mockResolvedValue(makeInvite()) });
    const { service } = makeService(repo, {
      getSummary: jest.fn().mockResolvedValue({ mode: 'suspended' }),
    });

    await expect(service.aceitar('tok', maria)).rejects.toThrow(ForbiddenException);
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it('recusa quando os assentos acabaram entre o convite e o clique', async () => {
    const repo = makeRepo({ findByTokenHash: jest.fn().mockResolvedValue(makeInvite()) });
    const { service } = makeService(repo, {
      assertSeatAvailable: jest.fn().mockRejectedValue(new BadRequestException('sem assento')),
    });

    await expect(service.aceitar('tok', maria)).rejects.toThrow(BadRequestException);
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it('aceita: cria a membership e devolve a empresa', async () => {
    const repo = makeRepo({ findByTokenHash: jest.fn().mockResolvedValue(makeInvite()) });
    const { service } = makeService(repo);

    await expect(service.aceitar('tok', maria)).resolves.toEqual({
      companyId: 'company-1',
      companyName: 'Acme Ltda',
    });
    expect(repo.accept).toHaveBeenCalledWith({
      inviteId: 'invite-1',
      companyId: 'company-1',
      userId: 'user-1',
      role: MembershipRole.member,
    });
  });

  it('corrida de aceite duplo: quem perde recebe erro, não uma segunda membership', async () => {
    const repo = makeRepo({
      findByTokenHash: jest.fn().mockResolvedValue(makeInvite()),
      accept: jest.fn().mockResolvedValue(false), // updateMany não pegou nenhuma linha
    });
    const { service } = makeService(repo);

    await expect(service.aceitar('tok', maria)).rejects.toThrow(BadRequestException);
  });
});

// ── revogar ────────────────────────────────────────────────────────────────────

describe('ConviteService.revogar', () => {
  it('revoga um convite pendente da própria empresa', async () => {
    const repo = makeRepo({
      findPendingById: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      revokeById: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);

    await service.revogar('company-1', 'invite-1', 'admin-1');
    expect(repo.revokeById).toHaveBeenCalledWith('invite-1');
  });

  it('não revoga convite de outra empresa', async () => {
    const repo = makeRepo({ findPendingById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);

    await expect(service.revogar('company-1', 'invite-de-outra', 'admin-1')).rejects.toThrow(
      'Convite não encontrado',
    );
    expect(repo.revokeById).not.toHaveBeenCalled();
  });
});
