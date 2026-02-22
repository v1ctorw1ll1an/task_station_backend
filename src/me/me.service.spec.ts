import { MeRepository } from './me.repository';
import { MeService } from './me.service';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    legalName: 'Acme Ltda',
    isActive: true,
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof MeRepository, jest.Mock>> = {},
): jest.Mocked<MeRepository> {
  return {
    findUserCompanyMemberships: jest.fn(),
    findUserWorkspaceMemberships: jest.fn(),
    findWorkspacesByIds: jest.fn(),
    findActiveCompaniesByIds: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<MeRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(repo: jest.Mocked<MeRepository>) {
  const logger = makeLogger();
  return new MeService(repo, logger as any);
}

// ── getMyCompanies ─────────────────────────────────────────────────────────────

describe('MeService.getMyCompanies', () => {
  it('retorna lista vazia quando usuário não tem memberships', async () => {
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toEqual([]);
    expect(repo.findActiveCompaniesByIds).not.toHaveBeenCalled();
  });

  it('retorna empresas via membership direto na empresa', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'admin' }]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].companyId).toBe('company-1');
    expect(result[0].role).toBe('admin');
    expect(result[0].legalName).toBe('Acme Ltda');
  });

  it('retorna empresas via membership em workspace', async () => {
    const company = makeCompany({ id: 'company-2', legalName: 'Beta Ltda' });
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([]),
      findUserWorkspaceMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'ws-1', role: 'workspace_admin' }]),
      findWorkspacesByIds: jest.fn().mockResolvedValue([{ id: 'ws-1', companyId: 'company-2' }]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].companyId).toBe('company-2');
    // sem membership direto na empresa → role é 'workspace_admin'
    expect(result[0].role).toBe('workspace_admin');
  });

  it('deduplica empresa quando usuário tem membership direta e via workspace', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'member' }]),
      findUserWorkspaceMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'ws-1', role: 'workspace_admin' }]),
      findWorkspacesByIds: jest.fn().mockResolvedValue([{ id: 'ws-1', companyId: 'company-1' }]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    // empresa aparece só uma vez
    expect(result).toHaveLength(1);
    expect(result[0].companyId).toBe('company-1');
    // o role é o da membership direta (não workspace_admin)
    expect(result[0].role).toBe('member');
  });

  it('ordena por role rank: admin > workspace_admin > member', async () => {
    const companies = [
      makeCompany({ id: 'c1', legalName: 'Membro Corp' }),
      makeCompany({ id: 'c2', legalName: 'Admin Corp' }),
      makeCompany({ id: 'c3', legalName: 'WS Admin Corp' }),
    ];
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([
        { resourceId: 'c1', role: 'member' },
        { resourceId: 'c2', role: 'admin' },
        { resourceId: 'c3', role: 'member' },
      ]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue(companies),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result[0].role).toBe('admin');
    expect(result[1].role).toBe('member');
    expect(result[2].role).toBe('member');
  });

  it('ordena alfabeticamente por legalName quando roles são iguais', async () => {
    const companies = [
      makeCompany({ id: 'c1', legalName: 'Zebra Corp' }),
      makeCompany({ id: 'c2', legalName: 'Alpha Corp' }),
    ];
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([
        { resourceId: 'c1', role: 'member' },
        { resourceId: 'c2', role: 'member' },
      ]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue(companies),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result[0].legalName).toBe('Alpha Corp');
    expect(result[1].legalName).toBe('Zebra Corp');
  });

  it('não chama findWorkspacesByIds quando não há workspace memberships', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'admin' }]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    await service.getMyCompanies('user-1');
    expect(repo.findWorkspacesByIds).not.toHaveBeenCalled();
  });

  it('retorna vazio quando todas as empresas encontradas foram removidas (inactive)', async () => {
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'admin' }]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([]), // empresa inativa/deletada
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toEqual([]);
  });
});
