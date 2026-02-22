import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuperadminRepository } from './superadmin.repository';
import { SuperadminService } from './superadmin.service';

// ── helpers ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-01T00:00:00Z');

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    legalName: 'Acme Ltda',
    taxId: '12345678000199',
    isActive: true,
    createdById: 'super-1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'admin@acme.com',
    name: 'Admin',
    phone: null,
    isActive: true,
    isSuperuser: false,
    mustResetPassword: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'membership-1',
    userId: 'user-1',
    resourceType: 'company',
    resourceId: 'company-1',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof SuperadminRepository, jest.Mock>> = {},
): jest.Mocked<SuperadminRepository> {
  return {
    findCompanyByTaxId: jest.fn(),
    findCompanyByTaxIdExcluding: jest.fn(),
    findCompanyById: jest.fn(),
    findCompanyDetail: jest.fn(),
    findCompanies: jest.fn(),
    createCompany: jest.fn(),
    updateCompany: jest.fn(),
    countWorkspacesByCompany: jest.fn(),
    countProjectsByCompany: jest.fn(),
    findUserByEmail: jest.fn(),
    findUserByEmailExcluding: jest.fn(),
    findUserById: jest.fn(),
    findUserDetail: jest.fn(),
    findUsers: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    updateProfile: jest.fn(),
    findMembership: jest.fn(),
    findCompanyMemberships: jest.fn(),
    countMemberships: jest.fn(),
    createMembership: jest.fn(),
    updateMembership: jest.fn(),
    createCompanyWithAdmin: jest.fn(),
    createCompanyWithNewAdmin: jest.fn(),
    findCompaniesByIds: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<SuperadminRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(
  repo: jest.Mocked<SuperadminRepository>,
  configOverrides: Record<string, unknown> = {},
) {
  const mailerService = {
    sendFirstAccessEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  };
  const authService = {
    generateFirstAccessToken: jest.fn().mockResolvedValue('raw-token-abc'),
    invalidateUserCredentials: jest.fn().mockResolvedValue('raw-token-abc'),
    getOrRegenerateFirstAccessToken: jest.fn().mockResolvedValue('raw-token-abc'),
  };
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        FRONTEND_URL: 'http://localhost:3000',
        ...configOverrides,
      };
      return map[key] ?? fallback;
    }),
    getOrThrow: jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        FRONTEND_URL: 'http://localhost:3000',
        ...configOverrides,
      };
      return map[key];
    }),
  } as unknown as ConfigService;
  const logger = makeLogger();

  return {
    service: new SuperadminService(
      repo,
      mailerService as any,
      authService as any,
      configService,
      logger as any,
    ),
    mailerService,
    authService,
  };
}

// ── createCompany ──────────────────────────────────────────────────────────────

describe('SuperadminService.createCompany', () => {
  it('lança ConflictException quando CNPJ já existe', async () => {
    const repo = makeRepo({ findCompanyByTaxId: jest.fn().mockResolvedValue(makeCompany()) });
    const { service } = makeService(repo);
    await expect(
      service.createCompany(
        { legalName: 'Nova', taxId: '12345678000199', adminEmail: 'a@a.com' },
        'super-1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('cria empresa com usuário existente — sem email, sem magic link', async () => {
    const company = makeCompany();
    const existingUser = makeUser({ mustResetPassword: false });
    const repo = makeRepo({
      findCompanyByTaxId: jest.fn().mockResolvedValue(null),
      findUserByEmail: jest.fn().mockResolvedValue(existingUser),
      createCompanyWithAdmin: jest.fn().mockResolvedValue(company),
    });
    const { service, mailerService } = makeService(repo);
    const result = await service.createCompany(
      { legalName: 'Acme', taxId: '00000000000000', adminEmail: 'admin@acme.com' },
      'super-1',
    );
    expect(repo.createCompanyWithAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ legalName: 'Acme' }),
      existingUser.id,
    );
    expect(result.emailSent).toBe(false);
    expect(result.magicLink).toBeNull();
    expect(mailerService.sendFirstAccessEmail).not.toHaveBeenCalled();
  });

  it('cria empresa com novo usuário — envia email e retorna magicLink', async () => {
    const company = makeCompany();
    const newAdmin = { id: 'admin-new', name: 'admin', email: 'new@acme.com' };
    const repo = makeRepo({
      findCompanyByTaxId: jest.fn().mockResolvedValue(null),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createCompanyWithNewAdmin: jest.fn().mockResolvedValue({ company, admin: newAdmin }),
    });
    const { service, mailerService, authService } = makeService(repo);
    const result = await service.createCompany(
      { legalName: 'Acme', taxId: '00000000000000', adminEmail: 'new@acme.com' },
      'super-1',
    );
    expect(authService.generateFirstAccessToken).toHaveBeenCalledWith('admin-new');
    expect(result.emailSent).toBe(true);
    expect(result.magicLink).toContain('/first-access?token=raw-token-abc');
    // email é disparado de forma assíncrona (fire-and-forget), então só verificamos que foi chamado
    await new Promise((r) => setTimeout(r, 10));
    expect(mailerService.sendFirstAccessEmail).toHaveBeenCalled();
  });

  it('usa adminEmail prefix como nome temporário quando adminName não fornecido', async () => {
    const company = makeCompany();
    const newAdmin = { id: 'admin-new', name: 'joao', email: 'joao@acme.com' };
    const repo = makeRepo({
      findCompanyByTaxId: jest.fn().mockResolvedValue(null),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createCompanyWithNewAdmin: jest.fn().mockResolvedValue({ company, admin: newAdmin }),
    });
    const { service } = makeService(repo);
    await service.createCompany(
      { legalName: 'Acme', taxId: '00000000000000', adminEmail: 'joao@acme.com' },
      'super-1',
    );
    const call = repo.createCompanyWithNewAdmin.mock.calls[0];
    expect((call[1] as { name: string }).name).toBe('joao');
  });

  it('usa adminName quando fornecido', async () => {
    const company = makeCompany();
    const newAdmin = { id: 'admin-new', name: 'João Silva', email: 'joao@acme.com' };
    const repo = makeRepo({
      findCompanyByTaxId: jest.fn().mockResolvedValue(null),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createCompanyWithNewAdmin: jest.fn().mockResolvedValue({ company, admin: newAdmin }),
    });
    const { service } = makeService(repo);
    await service.createCompany(
      {
        legalName: 'Acme',
        taxId: '00000000000000',
        adminEmail: 'joao@acme.com',
        adminName: 'João Silva',
      },
      'super-1',
    );
    const call = repo.createCompanyWithNewAdmin.mock.calls[0];
    expect((call[1] as { name: string }).name).toBe('João Silva');
  });
});

// ── listCompanies ──────────────────────────────────────────────────────────────

describe('SuperadminService.listCompanies', () => {
  it('retorna paginação correta', async () => {
    const repo = makeRepo({
      findCompanies: jest.fn().mockResolvedValue([[makeCompany(), makeCompany()], 5]),
    });
    const { service } = makeService(repo);
    const result = await service.listCompanies({ page: 2, limit: 2 });
    expect(result.total).toBe(5);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.data).toHaveLength(2);
  });

  it('passa filtro search e isActive para o repo', async () => {
    const repo = makeRepo({ findCompanies: jest.fn().mockResolvedValue([[], 0]) });
    const { service } = makeService(repo);
    await service.listCompanies({ search: 'Acme', isActive: true, page: 1, limit: 20 });
    const whereArg = repo.findCompanies.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.isActive).toBe(true);
    expect(whereArg.OR).toBeDefined();
  });
});

// ── updateCompany ──────────────────────────────────────────────────────────────

describe('SuperadminService.updateCompany', () => {
  it('lança NotFoundException quando empresa não existe', async () => {
    const repo = makeRepo({ findCompanyById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.updateCompany('company-1', { legalName: 'Nova' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lança ConflictException quando novo CNPJ já pertence a outra empresa', async () => {
    const repo = makeRepo({
      findCompanyById: jest.fn().mockResolvedValue(makeCompany({ taxId: 'old' })),
      findCompanyByTaxIdExcluding: jest.fn().mockResolvedValue(makeCompany({ id: 'other' })),
    });
    const { service } = makeService(repo);
    await expect(service.updateCompany('company-1', { taxId: '99999999000199' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('não verifica conflito de CNPJ quando taxId não muda', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findCompanyById: jest.fn().mockResolvedValue(company),
      updateCompany: jest.fn().mockResolvedValue(company),
    });
    const { service } = makeService(repo);
    await service.updateCompany('company-1', { taxId: company.taxId });
    expect(repo.findCompanyByTaxIdExcluding).not.toHaveBeenCalled();
  });

  it('atualiza com sucesso quando dados são válidos', async () => {
    const company = makeCompany();
    const updated = { ...company, legalName: 'Acme S.A.' };
    const repo = makeRepo({
      findCompanyById: jest.fn().mockResolvedValue(company),
      findCompanyByTaxIdExcluding: jest.fn().mockResolvedValue(null),
      updateCompany: jest.fn().mockResolvedValue(updated),
    });
    const { service } = makeService(repo);
    const result = await service.updateCompany('company-1', { legalName: 'Acme S.A.' });
    expect(result.legalName).toBe('Acme S.A.');
  });
});

// ── deactivateCompany ──────────────────────────────────────────────────────────

describe('SuperadminService.deactivateCompany', () => {
  it('lança NotFoundException quando empresa não existe', async () => {
    const repo = makeRepo({ findCompanyById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.deactivateCompany('company-1', 'super-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('chama updateCompany com isActive=false', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findCompanyById: jest.fn().mockResolvedValue(company),
      updateCompany: jest.fn().mockResolvedValue({ ...company, isActive: false }),
    });
    const { service } = makeService(repo);
    await service.deactivateCompany('company-1', 'super-1');
    expect(repo.updateCompany).toHaveBeenCalledWith('company-1', { isActive: false });
  });
});

// ── deleteCompany ──────────────────────────────────────────────────────────────

describe('SuperadminService.deleteCompany', () => {
  it('lança NotFoundException quando empresa não existe', async () => {
    const repo = makeRepo({ findCompanyById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.deleteCompany('company-1', 'super-1')).rejects.toThrow(NotFoundException);
  });

  it('seta deletedAt (soft delete)', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findCompanyById: jest.fn().mockResolvedValue(company),
      updateCompany: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.deleteCompany('company-1', 'super-1');
    const updateArg = repo.updateCompany.mock.calls[0][1] as Record<string, unknown>;
    expect(updateArg.deletedAt).toBeInstanceOf(Date);
  });
});

// ── updateUser ─────────────────────────────────────────────────────────────────

describe('SuperadminService.updateUser', () => {
  it('lança NotFoundException quando usuário não existe', async () => {
    const repo = makeRepo({ findUserById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.updateUser('user-1', {}, 'super-1')).rejects.toThrow(NotFoundException);
  });

  it('lança BadRequestException ao tentar alterar o próprio usuário', async () => {
    const user = makeUser({ id: 'super-1' });
    const repo = makeRepo({ findUserById: jest.fn().mockResolvedValue(user) });
    const { service } = makeService(repo);
    await expect(service.updateUser('super-1', {}, 'super-1')).rejects.toThrow(BadRequestException);
  });

  it('lança ConflictException quando email já existe para outro usuário', async () => {
    const user = makeUser({ email: 'old@x.com' });
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue(user),
      findUserByEmailExcluding: jest.fn().mockResolvedValue(makeUser({ id: 'other' })),
    });
    const { service } = makeService(repo);
    await expect(
      service.updateUser('user-1', { email: 'conflict@x.com' }, 'super-1'),
    ).rejects.toThrow(ConflictException);
  });

  it('seta mustResetPassword=true quando senha é redefinida pelo superadmin', async () => {
    const user = makeUser();
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue(user),
      findUserByEmailExcluding: jest.fn().mockResolvedValue(null),
      updateUser: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.updateUser('user-1', { password: 'NewPass123!' }, 'super-1');
    const dataArg = repo.updateUser.mock.calls[0][1];
    expect(dataArg.mustResetPassword).toBe(true);
    expect(dataArg.passwordHash).toBeDefined();
  });

  it('não seta mustResetPassword quando senha não muda', async () => {
    const user = makeUser();
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue(user),
      updateUser: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.updateUser('user-1', { isActive: false }, 'super-1');
    const dataArg = repo.updateUser.mock.calls[0][1];
    expect(dataArg.mustResetPassword).toBeUndefined();
  });
});

// ── updateProfile ──────────────────────────────────────────────────────────────

describe('SuperadminService.updateProfile', () => {
  it('lança NotFoundException quando usuário não existe', async () => {
    const repo = makeRepo({ findUserById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.updateProfile('user-1', {})).rejects.toThrow(NotFoundException);
  });

  it('lança ConflictException quando email já existe', async () => {
    const user = makeUser({ email: 'old@x.com' });
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue(user),
      findUserByEmailExcluding: jest.fn().mockResolvedValue(makeUser({ id: 'other' })),
    });
    const { service } = makeService(repo);
    await expect(service.updateProfile('user-1', { email: 'conflict@x.com' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('faz hash da senha quando password fornecida', async () => {
    const user = makeUser();
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue(user),
      updateProfile: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.updateProfile('user-1', { password: 'NewPass123!' });
    const dataArg = repo.updateProfile.mock.calls[0][1];
    expect(dataArg.passwordHash).toBeDefined();
    expect(dataArg.password).toBeUndefined();
  });
});

// ── getUserDetail ──────────────────────────────────────────────────────────────

describe('SuperadminService.getUserDetail', () => {
  it('lança NotFoundException quando usuário não existe', async () => {
    const repo = makeRepo({ findUserDetail: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.getUserDetail('user-1')).rejects.toThrow(NotFoundException);
  });

  it('enriquece memberships com dados da empresa', async () => {
    const userDetail = {
      ...makeUser(),
      memberships: [
        {
          id: 'm1',
          role: 'admin',
          resourceType: 'company',
          resourceId: 'company-1',
          createdAt: NOW,
        },
      ],
    };
    const company = makeCompany({ id: 'company-1' });
    const repo = makeRepo({
      findUserDetail: jest.fn().mockResolvedValue(userDetail),
      findCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const { service } = makeService(repo);
    const result = await service.getUserDetail('user-1');
    expect(result.memberships[0].company).toEqual(company);
  });
});

// ── getCompanyDetail ───────────────────────────────────────────────────────────

describe('SuperadminService.getCompanyDetail', () => {
  it('lança NotFoundException quando empresa não existe', async () => {
    const repo = makeRepo({ findCompanyDetail: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.getCompanyDetail('company-1')).rejects.toThrow(NotFoundException);
  });

  it('retorna dados com admins, workspacesCount e projectsCount', async () => {
    const company = {
      ...makeCompany(),
      createdBy: { id: 'super-1', name: 'Super', email: 's@s.com' },
    };
    const admins = [
      {
        id: 'm1',
        role: 'admin',
        createdAt: NOW,
        user: { id: 'user-1', name: 'Admin', email: 'a@a.com', phone: null, isActive: true },
      },
    ];
    const repo = makeRepo({
      findCompanyDetail: jest.fn().mockResolvedValue(company),
      findCompanyMemberships: jest.fn().mockResolvedValue(admins),
      countWorkspacesByCompany: jest.fn().mockResolvedValue(3),
      countProjectsByCompany: jest.fn().mockResolvedValue(7),
    });
    const { service } = makeService(repo);
    const result = await service.getCompanyDetail('company-1');
    expect(result.workspacesCount).toBe(3);
    expect(result.projectsCount).toBe(7);
    expect(result.admins).toHaveLength(1);
    expect(result.admins[0].membershipId).toBe('m1');
  });
});

// ── deactivateMembership ───────────────────────────────────────────────────────

describe('SuperadminService.deactivateMembership', () => {
  it('lança NotFoundException quando membership não existe', async () => {
    const repo = makeRepo({ findMembership: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(
      service.deactivateMembership('company-1', 'membership-1', 'super-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('lança BadRequestException ao tentar inativar único admin', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(makeMembership()),
      countMemberships: jest.fn().mockResolvedValue(0),
    });
    const { service } = makeService(repo);
    await expect(
      service.deactivateMembership('company-1', 'membership-1', 'super-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('soft-deleta membership quando há outro admin', async () => {
    const membership = makeMembership();
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(membership),
      countMemberships: jest.fn().mockResolvedValue(1),
      updateMembership: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.deactivateMembership('company-1', 'membership-1', 'super-1');
    expect(repo.updateMembership).toHaveBeenCalledWith(
      'membership-1',
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });
});

// ── invalidateUserCredentials ──────────────────────────────────────────────────

describe('SuperadminService.invalidateUserCredentials', () => {
  it('retorna magicLink com URL do frontend', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    const result = await service.invalidateUserCredentials('user-1', 'super-1');
    expect(result.magicLink).toBe('http://localhost:3000/first-access?token=raw-token-abc');
  });
});

// ── getMagicLink ───────────────────────────────────────────────────────────────

describe('SuperadminService.getMagicLink', () => {
  it('retorna magicLink=null quando usuário não precisa resetar senha', async () => {
    const repo = makeRepo();
    const { service, authService } = makeService(repo);
    authService.getOrRegenerateFirstAccessToken = jest.fn().mockResolvedValue(null);
    const result = await service.getMagicLink('user-1');
    expect(result.magicLink).toBeNull();
  });

  it('retorna magicLink com token quando usuário precisa resetar', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    const result = await service.getMagicLink('user-1');
    expect(result.magicLink).toBe('http://localhost:3000/first-access?token=raw-token-abc');
  });
});
