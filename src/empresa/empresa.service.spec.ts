import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipRole, ResourceType } from '../generated/prisma/client';
import { EmpresaRepository } from './empresa.repository';
import { EmpresaService } from './empresa.service';

// ── helpers ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-01T00:00:00Z');

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'user@acme.com',
    name: 'User',
    phone: null,
    passwordHash: 'hashed',
    isActive: true,
    mustResetPassword: false,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: 'Workspace 1',
    description: null,
    companyId: 'company-1',
    isActive: true,
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
    resourceType: ResourceType.company,
    resourceId: 'company-1',
    role: MembershipRole.member,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof EmpresaRepository, jest.Mock>> = {},
): jest.Mocked<EmpresaRepository> {
  return {
    findUserByEmail: jest.fn(),
    findUserById: jest.fn(),
    findUsers: jest.fn(),
    updateUser: jest.fn(),
    findWorkspaceById: jest.fn(),
    findWorkspaceByIdSelect: jest.fn(),
    findWorkspaces: jest.fn(),
    updateWorkspace: jest.fn(),
    softDeleteWorkspace: jest.fn(),
    findCompanyWorkspaceIds: jest.fn(),
    findCompanyWorkspaces: jest.fn(),
    findCompanyWorkspacesWithActive: jest.fn(),
    findMembership: jest.fn(),
    findMemberships: jest.fn(),
    findMembershipsSelect: jest.fn(),
    findMembershipsByUserAndScope: jest.fn(),
    countMemberships: jest.fn(),
    createMembership: jest.fn(),
    createMembershipSelect: jest.fn(),
    updateMembership: jest.fn(),
    updateMembershipSelect: jest.fn(),
    updateManyMemberships: jest.fn(),
    createWorkspaceWithNewAdmin: jest.fn(),
    createWorkspaceWithExistingAdmin: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<EmpresaRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(repo: jest.Mocked<EmpresaRepository>) {
  const mailerService = {
    sendFirstAccessEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  };
  const authService = {
    generateFirstAccessToken: jest.fn().mockResolvedValue('raw-token-abc'),
  };
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = { FRONTEND_URL: 'http://localhost:3000' };
      return map[key] ?? fallback;
    }),
    getOrThrow: jest.fn((key: string) => {
      const map: Record<string, unknown> = { FRONTEND_URL: 'http://localhost:3000' };
      if (!(key in map)) throw new Error(`Missing config key: ${key}`);
      return map[key];
    }),
  } as unknown as ConfigService;
  const logger = makeLogger();

  return {
    service: new EmpresaService(
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

// ── createWorkspace ────────────────────────────────────────────────────────────

describe('EmpresaService.createWorkspace', () => {
  it('caso 1: email novo — cria usuário, envia email, retorna workspace e admin sem passwordHash', async () => {
    const workspace = makeWorkspace();
    const newAdmin = makeUser({ id: 'admin-new', email: 'new@acme.com', name: 'new' });
    const repo = makeRepo({
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createWorkspaceWithNewAdmin: jest.fn().mockResolvedValue({ workspace, admin: newAdmin }),
    });
    const { service, mailerService, authService } = makeService(repo);

    const result = await service.createWorkspace(
      'company-1',
      { name: 'WS', adminEmail: 'new@acme.com' },
      'creator-1',
    );

    expect(authService.generateFirstAccessToken).toHaveBeenCalledWith('admin-new');
    expect(result.workspace.id).toBe('ws-1');
    expect((result.admin as Record<string, unknown>).passwordHash).toBeUndefined();
    // fire-and-forget email
    await new Promise((r) => setTimeout(r, 10));
    expect(mailerService.sendFirstAccessEmail).toHaveBeenCalled();
  });

  it('caso 1: usa prefixo do email como nome temporário', async () => {
    const workspace = makeWorkspace();
    const newAdmin = makeUser({ id: 'admin-new', email: 'joao@acme.com', name: 'joao' });
    const repo = makeRepo({
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createWorkspaceWithNewAdmin: jest.fn().mockResolvedValue({ workspace, admin: newAdmin }),
    });
    const { service } = makeService(repo);

    await service.createWorkspace(
      'company-1',
      { name: 'WS', adminEmail: 'joao@acme.com' },
      'creator-1',
    );

    const callArg = repo.createWorkspaceWithNewAdmin.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.adminName).toBe('joao');
  });

  it('caso 2: email existente — vincula usuário existente ao workspace sem enviar email', async () => {
    const existingUser = makeUser({ id: 'existing-1', email: 'existing@acme.com' });
    const workspace = makeWorkspace();
    const repo = makeRepo({
      findUserByEmail: jest.fn().mockResolvedValue(existingUser),
      createWorkspaceWithExistingAdmin: jest.fn().mockResolvedValue(workspace),
    });
    const { service, mailerService, authService } = makeService(repo);

    const result = await service.createWorkspace(
      'company-1',
      { name: 'WS', adminEmail: 'existing@acme.com' },
      'creator-1',
    );

    expect(repo.createWorkspaceWithExistingAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ adminUserId: 'existing-1' }),
    );
    expect(authService.generateFirstAccessToken).not.toHaveBeenCalled();
    expect(mailerService.sendFirstAccessEmail).not.toHaveBeenCalled();
    expect(result.workspace.id).toBe('ws-1');
    expect((result.admin as Record<string, unknown>).passwordHash).toBeUndefined();
  });
});

// ── listWorkspaces ─────────────────────────────────────────────────────────────

describe('EmpresaService.listWorkspaces', () => {
  it('retorna paginação correta', async () => {
    const repo = makeRepo({
      findWorkspaces: jest.fn().mockResolvedValue([[makeWorkspace()], 1]),
    });
    const { service } = makeService(repo);
    const result = await service.listWorkspaces('company-1', { page: 1, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it('passa filtro isActive para o repo', async () => {
    const repo = makeRepo({
      findWorkspaces: jest.fn().mockResolvedValue([[], 0]),
    });
    const { service } = makeService(repo);
    await service.listWorkspaces('company-1', { isActive: false });
    const whereArg = repo.findWorkspaces.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.isActive).toBe(false);
  });

  it('não passa isActive quando não fornecido', async () => {
    const repo = makeRepo({
      findWorkspaces: jest.fn().mockResolvedValue([[], 0]),
    });
    const { service } = makeService(repo);
    await service.listWorkspaces('company-1', {});
    const whereArg = repo.findWorkspaces.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.isActive).toBeUndefined();
  });
});

// ── getWorkspace ───────────────────────────────────────────────────────────────

describe('EmpresaService.getWorkspace', () => {
  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({ findWorkspaceByIdSelect: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.getWorkspace('company-1', 'ws-1')).rejects.toThrow(NotFoundException);
  });

  it('retorna workspace quando existe', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({ findWorkspaceByIdSelect: jest.fn().mockResolvedValue(ws) });
    const { service } = makeService(repo);
    const result = await service.getWorkspace('company-1', 'ws-1');
    expect(result.id).toBe('ws-1');
  });
});

// ── updateWorkspace ────────────────────────────────────────────────────────────

describe('EmpresaService.updateWorkspace', () => {
  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({ findWorkspaceById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.updateWorkspace('company-1', 'ws-1', { name: 'X' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('atualiza workspace com sucesso', async () => {
    const ws = makeWorkspace();
    const updated = { ...ws, name: 'Novo Nome' };
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      updateWorkspace: jest.fn().mockResolvedValue(updated),
    });
    const { service } = makeService(repo);
    const result = await service.updateWorkspace('company-1', 'ws-1', { name: 'Novo Nome' });
    expect(result.name).toBe('Novo Nome');
  });
});

// ── deactivateWorkspace ────────────────────────────────────────────────────────

describe('EmpresaService.deactivateWorkspace', () => {
  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({ findWorkspaceById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.deactivateWorkspace('company-1', 'ws-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('chama updateWorkspace com isActive=false', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      updateWorkspace: jest.fn().mockResolvedValue({ ...ws, isActive: false }),
    });
    const { service } = makeService(repo);
    await service.deactivateWorkspace('company-1', 'ws-1');
    expect(repo.updateWorkspace).toHaveBeenCalledWith('ws-1', { isActive: false });
  });
});

// ── activateWorkspace ──────────────────────────────────────────────────────────

describe('EmpresaService.activateWorkspace', () => {
  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({ findWorkspaceById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.activateWorkspace('company-1', 'ws-1')).rejects.toThrow(NotFoundException);
  });

  it('chama updateWorkspace com isActive=true', async () => {
    const ws = makeWorkspace({ isActive: false });
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      updateWorkspace: jest.fn().mockResolvedValue({ ...ws, isActive: true }),
    });
    const { service } = makeService(repo);
    await service.activateWorkspace('company-1', 'ws-1');
    expect(repo.updateWorkspace).toHaveBeenCalledWith('ws-1', { isActive: true });
  });
});

// ── deleteWorkspace ────────────────────────────────────────────────────────────

describe('EmpresaService.deleteWorkspace', () => {
  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({ findWorkspaceById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.deleteWorkspace('company-1', 'ws-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('chama softDeleteWorkspace com workspaceId', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      softDeleteWorkspace: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.deleteWorkspace('company-1', 'ws-1', 'user-1');
    expect(repo.softDeleteWorkspace).toHaveBeenCalledWith('ws-1');
  });
});

// ── updateMember ───────────────────────────────────────────────────────────────

describe('EmpresaService.updateMember', () => {
  it('lança BadRequestException ao tentar alterar o próprio usuário', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await expect(
      service.updateMember('company-1', 'user-1', { isActive: false }, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança ForbiddenException ao tentar alterar um admin da empresa', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(makeMembership({ role: MembershipRole.admin })),
    });
    const { service } = makeService(repo);
    await expect(
      service.updateMember('company-1', 'user-2', { isActive: false }, 'user-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lança NotFoundException quando membro não encontrado na empresa', async () => {
    const repo = makeRepo({
      // assertNotCompanyAdmin: findMembership com role=admin retorna null (não é admin)
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin → não é admin
        .mockResolvedValueOnce(null), // busca de membership na empresa → não encontrado
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([]),
    });
    const { service } = makeService(repo);
    await expect(
      service.updateMember('company-1', 'user-2', { isActive: false }, 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('atualiza usuário com sucesso quando membro válido', async () => {
    const user = makeUser({ id: 'user-2' });
    const membership = makeMembership({ userId: 'user-2' });
    const updatedUser = { ...user, isActive: false };
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin → não é admin
        .mockResolvedValueOnce(membership), // encontrou membership na empresa
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([{ id: 'ws-1' }]),
      updateUser: jest.fn().mockResolvedValue(updatedUser),
    });
    const { service } = makeService(repo);
    const result = await service.updateMember('company-1', 'user-2', { isActive: false }, 'user-1');
    expect(result.isActive).toBe(false);
    expect(repo.updateUser).toHaveBeenCalledWith('user-2', { isActive: false });
  });
});

// ── removeMember ───────────────────────────────────────────────────────────────

describe('EmpresaService.removeMember', () => {
  it('lança BadRequestException ao tentar remover a si mesmo', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await expect(service.removeMember('company-1', 'user-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lança ForbiddenException ao tentar remover um admin da empresa', async () => {
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValue(makeMembership({ userId: 'user-2', role: MembershipRole.admin })),
    });
    const { service } = makeService(repo);
    await expect(service.removeMember('company-1', 'user-2', 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('lança NotFoundException quando membro não encontrado', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(null), // assertNotCompanyAdmin → não é admin
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([]),
      updateManyMemberships: jest.fn().mockResolvedValue({ count: 0 }),
    });
    const { service } = makeService(repo);
    await expect(service.removeMember('company-1', 'user-2', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('soft-deleta todos os memberships do membro', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(null), // assertNotCompanyAdmin → não é admin
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]),
      updateManyMemberships: jest.fn().mockResolvedValue({ count: 3 }),
    });
    const { service } = makeService(repo);
    await service.removeMember('company-1', 'user-2', 'user-1');
    const dataArg = repo.updateManyMemberships.mock.calls[0][1] as Record<string, unknown>;
    expect(dataArg.deletedAt as Date).toBeInstanceOf(Date);
  });
});

// ── promoteToAdmin ─────────────────────────────────────────────────────────────

describe('EmpresaService.promoteToAdmin', () => {
  it('lança NotFoundException quando usuário não é membro da empresa', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(null),
    });
    const { service } = makeService(repo);
    await expect(
      service.promoteToAdmin('company-1', { userId: 'user-2' }, 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('lança ConflictException quando usuário já é admin', async () => {
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(makeMembership({ userId: 'user-2' })) // é membro
        .mockResolvedValueOnce(makeMembership({ userId: 'user-2', role: MembershipRole.admin })), // já é admin
    });
    const { service } = makeService(repo);
    await expect(
      service.promoteToAdmin('company-1', { userId: 'user-2' }, 'user-1'),
    ).rejects.toThrow(ConflictException);
  });

  it('cria membership de admin com sucesso', async () => {
    const newMembership = makeMembership({ userId: 'user-2', role: MembershipRole.admin });
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(makeMembership({ userId: 'user-2' })) // é membro
        .mockResolvedValueOnce(null), // ainda não é admin
      createMembershipSelect: jest.fn().mockResolvedValue(newMembership),
    });
    const { service } = makeService(repo);
    const result = await service.promoteToAdmin('company-1', { userId: 'user-2' }, 'user-1');
    expect(repo.createMembershipSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        resourceType: ResourceType.company,
        role: MembershipRole.admin,
      }),
    );
    expect(result.role).toBe(MembershipRole.admin);
  });
});

// ── revokeAdmin ────────────────────────────────────────────────────────────────

describe('EmpresaService.revokeAdmin', () => {
  it('lança BadRequestException ao tentar revogar o próprio papel', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await expect(service.revokeAdmin('company-1', 'user-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lança NotFoundException quando usuário não é admin', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(null),
    });
    const { service } = makeService(repo);
    await expect(service.revokeAdmin('company-1', 'user-2', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lança BadRequestException quando é o único admin', async () => {
    const adminMembership = makeMembership({ userId: 'user-2', role: MembershipRole.admin });
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(adminMembership),
      countMemberships: jest.fn().mockResolvedValue(0),
    });
    const { service } = makeService(repo);
    await expect(service.revokeAdmin('company-1', 'user-2', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('soft-deleta o membership de admin quando há outro admin', async () => {
    const adminMembership = makeMembership({
      id: 'membership-admin',
      userId: 'user-2',
      role: MembershipRole.admin,
    });
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(adminMembership),
      countMemberships: jest.fn().mockResolvedValue(1),
      updateMembership: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.revokeAdmin('company-1', 'user-2', 'user-1');
    expect(repo.updateMembership).toHaveBeenCalledWith(
      'membership-admin',
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });
});

// ── getMemberRoles ─────────────────────────────────────────────────────────────

describe('EmpresaService.getMemberRoles', () => {
  it('lança NotFoundException quando usuário não existe', async () => {
    const repo = makeRepo({ findUserById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.getMemberRoles('company-1', 'user-2')).rejects.toThrow(NotFoundException);
  });

  it('retorna companyRole=null quando usuário não tem membership na empresa', async () => {
    const user = makeUser({ id: 'user-2' });
    const ws = { id: 'ws-1', name: 'WS', isActive: true };
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue(user),
      findCompanyWorkspacesWithActive: jest.fn().mockResolvedValue([ws]),
      findMembershipsByUserAndScope: jest.fn().mockResolvedValue([]),
    });
    const { service } = makeService(repo);
    const result = await service.getMemberRoles('company-1', 'user-2');
    expect(result.companyRole).toBeNull();
    expect(result.companyMembershipId).toBeNull();
    expect(result.workspaceRoles[0].role).toBeNull();
  });

  it('retorna companyRole e workspaceRoles corretamente', async () => {
    const user = makeUser({ id: 'user-2' });
    const ws1 = { id: 'ws-1', name: 'WS1', isActive: true };
    const ws2 = { id: 'ws-2', name: 'WS2', isActive: true };
    const memberships = [
      {
        id: 'm-company',
        resourceType: ResourceType.company,
        resourceId: 'company-1',
        role: MembershipRole.admin,
      },
      {
        id: 'm-ws1',
        resourceType: ResourceType.workspace,
        resourceId: 'ws-1',
        role: MembershipRole.workspace_admin,
      },
    ];
    const repo = makeRepo({
      findUserById: jest.fn().mockResolvedValue(user),
      findCompanyWorkspacesWithActive: jest.fn().mockResolvedValue([ws1, ws2]),
      findMembershipsByUserAndScope: jest.fn().mockResolvedValue(memberships),
    });
    const { service } = makeService(repo);
    const result = await service.getMemberRoles('company-1', 'user-2');
    expect(result.companyRole).toBe(MembershipRole.admin);
    expect(result.companyMembershipId).toBe('m-company');
    const ws1Role = result.workspaceRoles.find((w) => w.workspaceId === 'ws-1');
    const ws2Role = result.workspaceRoles.find((w) => w.workspaceId === 'ws-2');
    expect(ws1Role?.role).toBe(MembershipRole.workspace_admin);
    expect(ws2Role?.role).toBeNull();
  });
});

// ── promoteToWorkspaceAdmin ────────────────────────────────────────────────────

describe('EmpresaService.promoteToWorkspaceAdmin', () => {
  it('lança ForbiddenException quando usuário é admin da empresa', async () => {
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValue(makeMembership({ userId: 'user-2', role: MembershipRole.admin })),
    });
    const { service } = makeService(repo);
    await expect(
      service.promoteToWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(null), // não é admin
      findWorkspaceById: jest.fn().mockResolvedValue(null),
    });
    const { service } = makeService(repo);
    await expect(
      service.promoteToWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('lança NotFoundException quando usuário não é membro da empresa', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin → não é admin
        .mockResolvedValueOnce(null), // anyMembership → não é membro
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([{ id: 'ws-1' }]),
    });
    const { service } = makeService(repo);
    await expect(
      service.promoteToWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('lança ConflictException quando usuário já é workspace_admin', async () => {
    const ws = makeWorkspace();
    const existingMembership = makeMembership({
      userId: 'user-2',
      resourceType: ResourceType.workspace,
      resourceId: 'ws-1',
      role: MembershipRole.workspace_admin,
    });
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin
        .mockResolvedValueOnce(makeMembership()) // anyMembership → é membro
        .mockResolvedValueOnce(existingMembership), // já tem membership no workspace
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([{ id: 'ws-1' }]),
    });
    const { service } = makeService(repo);
    await expect(
      service.promoteToWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1'),
    ).rejects.toThrow(ConflictException);
  });

  it('atualiza membership existente para workspace_admin quando era member', async () => {
    const ws = makeWorkspace();
    const existingMembership = makeMembership({
      id: 'membership-ws',
      userId: 'user-2',
      resourceType: ResourceType.workspace,
      resourceId: 'ws-1',
      role: MembershipRole.member,
    });
    const updatedMembership = { ...existingMembership, role: MembershipRole.workspace_admin };
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin
        .mockResolvedValueOnce(makeMembership()) // anyMembership
        .mockResolvedValueOnce(existingMembership), // tem membership no workspace como member
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([{ id: 'ws-1' }]),
      updateMembershipSelect: jest.fn().mockResolvedValue(updatedMembership),
    });
    const { service } = makeService(repo);
    await service.promoteToWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1');
    expect(repo.updateMembershipSelect).toHaveBeenCalledWith('membership-ws', {
      role: 'workspace_admin',
    });
  });

  it('cria novo membership de workspace_admin quando usuário não tem membership no workspace', async () => {
    const ws = makeWorkspace();
    const companyMembership = makeMembership({ userId: 'user-2' });
    const newMembership = makeMembership({
      userId: 'user-2',
      resourceType: ResourceType.workspace,
      resourceId: 'ws-1',
      role: MembershipRole.workspace_admin,
    });
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin
        .mockResolvedValueOnce(companyMembership) // anyMembership
        .mockResolvedValueOnce(null) // sem membership no workspace
        .mockResolvedValueOnce(companyMembership), // tem membership na empresa
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([{ id: 'ws-1' }]),
      createMembershipSelect: jest.fn().mockResolvedValue(newMembership),
    });
    const { service } = makeService(repo);
    await service.promoteToWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1');
    expect(repo.createMembershipSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        resourceType: ResourceType.workspace,
        role: MembershipRole.workspace_admin,
      }),
    );
  });

  it('cria membership na empresa como member quando usuário não tem vínculo direto com a empresa', async () => {
    const ws = makeWorkspace();
    // Usuário tem membership em outro workspace mas não na empresa diretamente
    const workspaceMembership = makeMembership({
      userId: 'user-2',
      resourceType: ResourceType.workspace,
      resourceId: 'ws-other',
      role: MembershipRole.workspace_admin,
    });
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin
        .mockResolvedValueOnce(workspaceMembership) // anyMembership → é membro via workspace
        .mockResolvedValueOnce(null) // sem membership no ws-1
        .mockResolvedValueOnce(null), // sem membership direta na empresa
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findCompanyWorkspaceIds: jest.fn().mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-other' }]),
      createMembership: jest.fn().mockResolvedValue({}),
      createMembershipSelect: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.promoteToWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1');
    expect(repo.createMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        resourceType: ResourceType.company,
        role: MembershipRole.member,
      }),
    );
  });
});

// ── revokeWorkspaceAdmin ───────────────────────────────────────────────────────

describe('EmpresaService.revokeWorkspaceAdmin', () => {
  it('lança ForbiddenException quando usuário é admin da empresa', async () => {
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValue(makeMembership({ userId: 'user-2', role: MembershipRole.admin })),
    });
    const { service } = makeService(repo);
    await expect(
      service.revokeWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(null), // não é admin
      findWorkspaceById: jest.fn().mockResolvedValue(null),
    });
    const { service } = makeService(repo);
    await expect(
      service.revokeWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('lança NotFoundException quando usuário não tem papel workspace_admin no workspace', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin
        .mockResolvedValueOnce(null), // sem workspace_admin membership
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
    });
    const { service } = makeService(repo);
    await expect(
      service.revokeWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('soft-deleta o membership de workspace_admin', async () => {
    const ws = makeWorkspace();
    const wsMembership = makeMembership({
      id: 'ws-membership',
      userId: 'user-2',
      resourceType: ResourceType.workspace,
      resourceId: 'ws-1',
      role: MembershipRole.workspace_admin,
    });
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // assertNotCompanyAdmin
        .mockResolvedValueOnce(wsMembership), // tem workspace_admin
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      updateMembership: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.revokeWorkspaceAdmin('company-1', 'ws-1', 'user-2', 'user-1');
    expect(repo.updateMembership).toHaveBeenCalledWith(
      'ws-membership',
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });
});
