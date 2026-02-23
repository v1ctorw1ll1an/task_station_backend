import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole, ResourceType } from '../generated/prisma/client';
import { WorkspaceRepository } from './workspace.repository';
import { WorkspaceService } from './workspace.service';

// ── helpers ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-01T00:00:00Z');

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    name: 'Projeto 1',
    description: null,
    isActive: true,
    workspaceId: 'ws-1',
    createdById: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    companyId: 'company-1',
    isActive: true,
    ...overrides,
  };
}

function makeMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'membership-1',
    userId: 'user-1',
    resourceType: ResourceType.workspace,
    resourceId: 'ws-1',
    role: MembershipRole.member,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    name: 'User',
    email: 'user@acme.com',
    phone: null,
    isActive: true,
    createdAt: NOW,
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof WorkspaceRepository, jest.Mock>> = {},
): jest.Mocked<WorkspaceRepository> {
  return {
    findWorkspaceById: jest.fn(),
    findWorkspaceCompanyId: jest.fn(),
    findProjectById: jest.fn(),
    findProjectByIdSelect: jest.fn(),
    findProjects: jest.fn(),
    updateProject: jest.fn(),
    createProjectWithColumns: jest.fn(),
    softDeleteProjectCascade: jest.fn(),
    findMembership: jest.fn(),
    findMemberships: jest.fn(),
    countMemberships: jest.fn(),
    createMembership: jest.fn(),
    createMembershipSelect: jest.fn(),
    updateMembership: jest.fn(),
    updateMembershipSelect: jest.fn(),
    findUserById: jest.fn(),
    findUsers: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<WorkspaceRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(repo: jest.Mocked<WorkspaceRepository>) {
  const logger = makeLogger();
  return { service: new WorkspaceService(repo, logger as any), logger };
}

// ── createProject ──────────────────────────────────────────────────────────────

describe('WorkspaceService.createProject', () => {
  it('chama createProjectWithColumns com parâmetros corretos', async () => {
    const project = makeProject();
    const columns = [
      { id: 'col-1', name: 'A Fazer', order: 1, projectId: 'project-1' },
      { id: 'col-2', name: 'Em Progresso', order: 2, projectId: 'project-1' },
      { id: 'col-3', name: 'Concluído', order: 3, projectId: 'project-1' },
    ];
    const repo = makeRepo({
      createProjectWithColumns: jest.fn().mockResolvedValue({ project, columns }),
    });
    const { service } = makeService(repo);

    const result = await service.createProject('ws-1', { name: 'Projeto 1' }, 'user-1');

    expect(repo.createProjectWithColumns).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: 'Projeto 1',
      description: undefined,
      createdById: 'user-1',
    });
    expect(result.project.id).toBe('project-1');
    expect(result.columns).toHaveLength(3);
  });

  it('passa description quando fornecida', async () => {
    const project = makeProject({ description: 'Descrição' });
    const repo = makeRepo({
      createProjectWithColumns: jest.fn().mockResolvedValue({ project, columns: [] }),
    });
    const { service } = makeService(repo);

    await service.createProject('ws-1', { name: 'P', description: 'Descrição' }, 'user-1');

    const callArg = repo.createProjectWithColumns.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.description).toBe('Descrição');
  });
});

// ── listProjects ───────────────────────────────────────────────────────────────

describe('WorkspaceService.listProjects', () => {
  it('retorna paginação correta', async () => {
    const repo = makeRepo({
      findProjects: jest.fn().mockResolvedValue([[makeProject()], 1]),
    });
    const { service } = makeService(repo);
    const result = await service.listProjects('ws-1', { page: 1, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it('admin: passa filtro isActive para o repo quando fornecido', async () => {
    const repo = makeRepo({
      findProjects: jest.fn().mockResolvedValue([[], 0]),
    });
    const { service } = makeService(repo);
    await service.listProjects('ws-1', { isActive: false }, true);
    const whereArg = repo.findProjects.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.isActive).toBe(false);
  });

  it('admin: não passa isActive no where quando não fornecido', async () => {
    const repo = makeRepo({
      findProjects: jest.fn().mockResolvedValue([[], 0]),
    });
    const { service } = makeService(repo);
    await service.listProjects('ws-1', {}, true);
    const whereArg = repo.findProjects.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.isActive).toBeUndefined();
  });

  it('membro (isAdmin=false): força isActive=true independente do query', async () => {
    const repo = makeRepo({
      findProjects: jest.fn().mockResolvedValue([[], 0]),
    });
    const { service } = makeService(repo);
    await service.listProjects('ws-1', { isActive: false });
    const whereArg = repo.findProjects.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.isActive).toBe(true);
  });

  it('usa defaults page=1 e limit=20', async () => {
    const repo = makeRepo({
      findProjects: jest.fn().mockResolvedValue([[], 0]),
    });
    const { service } = makeService(repo);
    const result = await service.listProjects('ws-1', {});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(repo.findProjects).toHaveBeenCalledWith(expect.anything(), 1, 20);
  });
});

// ── getProject ─────────────────────────────────────────────────────────────────

describe('WorkspaceService.getProject', () => {
  it('lança NotFoundException quando projeto não existe', async () => {
    const repo = makeRepo({ findProjectByIdSelect: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.getProject('ws-1', 'project-1')).rejects.toThrow(NotFoundException);
  });

  it('retorna projeto quando existe', async () => {
    const project = makeProject();
    const repo = makeRepo({ findProjectByIdSelect: jest.fn().mockResolvedValue(project) });
    const { service } = makeService(repo);
    const result = await service.getProject('ws-1', 'project-1');
    expect(result.id).toBe('project-1');
  });
});

// ── updateProject ──────────────────────────────────────────────────────────────

describe('WorkspaceService.updateProject', () => {
  it('lança NotFoundException quando projeto não existe', async () => {
    const repo = makeRepo({ findProjectById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.updateProject('ws-1', 'project-1', { name: 'X' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('atualiza projeto com sucesso', async () => {
    const project = makeProject();
    const updated = { ...project, name: 'Novo Nome' };
    const repo = makeRepo({
      findProjectById: jest.fn().mockResolvedValue(project),
      updateProject: jest.fn().mockResolvedValue(updated),
    });
    const { service } = makeService(repo);
    const result = await service.updateProject('ws-1', 'project-1', { name: 'Novo Nome' });
    expect(result.name).toBe('Novo Nome');
    expect(repo.updateProject).toHaveBeenCalledWith('project-1', { name: 'Novo Nome' });
  });
});

// ── deactivateProject ──────────────────────────────────────────────────────────

describe('WorkspaceService.deactivateProject', () => {
  it('lança NotFoundException quando projeto não existe', async () => {
    const repo = makeRepo({ findProjectById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.deactivateProject('ws-1', 'project-1')).rejects.toThrow(NotFoundException);
  });

  it('chama updateProject com isActive=false', async () => {
    const project = makeProject();
    const repo = makeRepo({
      findProjectById: jest.fn().mockResolvedValue(project),
      updateProject: jest.fn().mockResolvedValue({ ...project, isActive: false }),
    });
    const { service } = makeService(repo);
    await service.deactivateProject('ws-1', 'project-1');
    expect(repo.updateProject).toHaveBeenCalledWith('project-1', { isActive: false });
  });
});

// ── activateProject ────────────────────────────────────────────────────────────

describe('WorkspaceService.activateProject', () => {
  it('lança NotFoundException quando projeto não existe', async () => {
    const repo = makeRepo({ findProjectById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.activateProject('ws-1', 'project-1')).rejects.toThrow(NotFoundException);
  });

  it('chama updateProject com isActive=true', async () => {
    const project = makeProject({ isActive: false });
    const repo = makeRepo({
      findProjectById: jest.fn().mockResolvedValue(project),
      updateProject: jest.fn().mockResolvedValue({ ...project, isActive: true }),
    });
    const { service } = makeService(repo);
    await service.activateProject('ws-1', 'project-1');
    expect(repo.updateProject).toHaveBeenCalledWith('project-1', { isActive: true });
  });
});

// ── deleteProject ──────────────────────────────────────────────────────────────

describe('WorkspaceService.deleteProject', () => {
  it('lança NotFoundException quando projeto não existe', async () => {
    const repo = makeRepo({ findProjectById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.deleteProject('ws-1', 'project-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('chama softDeleteProjectCascade com projectId', async () => {
    const project = makeProject();
    const repo = makeRepo({
      findProjectById: jest.fn().mockResolvedValue(project),
      softDeleteProjectCascade: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.deleteProject('ws-1', 'project-1', 'user-1');
    expect(repo.softDeleteProjectCascade).toHaveBeenCalledWith('project-1');
  });
});

// ── listMembers ────────────────────────────────────────────────────────────────

describe('WorkspaceService.listMembers', () => {
  it('retorna lista vazia quando não há memberships', async () => {
    const repo = makeRepo({
      findMemberships: jest.fn().mockResolvedValue([]),
    });
    const { service } = makeService(repo);
    const result = await service.listMembers('ws-1', {});
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('retorna membros paginados com dados de membership', async () => {
    const memberships = [
      { id: 'm-1', userId: 'user-1', role: MembershipRole.workspace_admin, createdAt: NOW },
      { id: 'm-2', userId: 'user-2', role: MembershipRole.member, createdAt: NOW },
    ];
    const users = [makeUser({ id: 'user-1' }), makeUser({ id: 'user-2', name: 'User 2' })];
    const repo = makeRepo({
      findMemberships: jest.fn().mockResolvedValue(memberships),
      findUsers: jest.fn().mockResolvedValue([users, 2]),
    });
    const { service } = makeService(repo);
    const result = await service.listMembers('ws-1', {});
    expect(result.total).toBe(2);
    expect(result.data[0].membershipId).toBe('m-1');
    expect(result.data[0].role).toBe(MembershipRole.workspace_admin);
    expect(result.data[0].user.id).toBe('user-1');
  });

  it('passa filtro isActive para findUsers quando fornecido', async () => {
    const memberships = [
      { id: 'm-1', userId: 'user-1', role: MembershipRole.member, createdAt: NOW },
    ];
    const repo = makeRepo({
      findMemberships: jest.fn().mockResolvedValue(memberships),
      findUsers: jest.fn().mockResolvedValue([[makeUser()], 1]),
    });
    const { service } = makeService(repo);
    await service.listMembers('ws-1', { isActive: true });
    const whereArg = repo.findUsers.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.isActive).toBe(true);
  });

  it('passa filtro search como OR para findUsers quando fornecido', async () => {
    const memberships = [
      { id: 'm-1', userId: 'user-1', role: MembershipRole.member, createdAt: NOW },
    ];
    const repo = makeRepo({
      findMemberships: jest.fn().mockResolvedValue(memberships),
      findUsers: jest.fn().mockResolvedValue([[makeUser()], 1]),
    });
    const { service } = makeService(repo);
    await service.listMembers('ws-1', { search: 'João' });
    const whereArg = repo.findUsers.mock.calls[0][0] as Record<string, unknown>;
    expect(whereArg.OR).toBeDefined();
  });

  it('usa defaults page=1 e limit=20', async () => {
    const memberships = [
      { id: 'm-1', userId: 'user-1', role: MembershipRole.member, createdAt: NOW },
    ];
    const repo = makeRepo({
      findMemberships: jest.fn().mockResolvedValue(memberships),
      findUsers: jest.fn().mockResolvedValue([[], 0]),
    });
    const { service } = makeService(repo);
    const result = await service.listMembers('ws-1', {});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(repo.findUsers).toHaveBeenCalledWith(expect.anything(), 1, 20);
  });
});

// ── addMember ──────────────────────────────────────────────────────────────────

describe('WorkspaceService.addMember', () => {
  it('lança NotFoundException quando workspace não existe', async () => {
    const repo = makeRepo({ findWorkspaceById: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.addMember('ws-1', { userId: 'user-2' }, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lança ConflictException quando usuário já é membro', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findMembership: jest.fn().mockResolvedValue(makeMembership({ userId: 'user-2' })),
    });
    const { service } = makeService(repo);
    await expect(service.addMember('ws-1', { userId: 'user-2' }, 'user-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('cria membership no workspace com role=member', async () => {
    const ws = makeWorkspace();
    const newMembership = makeMembership({ userId: 'user-2' });
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // sem membership no workspace
        .mockResolvedValueOnce(makeMembership({ resourceType: ResourceType.company })), // já tem na empresa
      createMembershipSelect: jest.fn().mockResolvedValue(newMembership),
    });
    const { service } = makeService(repo);
    const result = await service.addMember('ws-1', { userId: 'user-2' }, 'user-1');
    expect(repo.createMembershipSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        resourceType: ResourceType.workspace,
        resourceId: 'ws-1',
        role: MembershipRole.member,
      }),
    );
    expect(result.id).toBe('membership-1');
  });

  it('cria membership na empresa-pai quando usuário não tem vínculo com empresa', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // sem membership no workspace
        .mockResolvedValueOnce(null), // sem membership na empresa-pai
      createMembershipSelect: jest.fn().mockResolvedValue(makeMembership()),
      createMembership: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.addMember('ws-1', { userId: 'user-2' }, 'user-1');
    expect(repo.createMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        resourceType: ResourceType.company,
        resourceId: 'company-1',
        role: MembershipRole.member,
      }),
    );
  });

  it('não cria membership na empresa quando usuário já é membro da empresa', async () => {
    const ws = makeWorkspace();
    const repo = makeRepo({
      findWorkspaceById: jest.fn().mockResolvedValue(ws),
      findMembership: jest
        .fn()
        .mockResolvedValueOnce(null) // sem membership no workspace
        .mockResolvedValueOnce(makeMembership({ resourceType: ResourceType.company })), // já tem na empresa
      createMembershipSelect: jest.fn().mockResolvedValue(makeMembership()),
      createMembership: jest.fn(),
    });
    const { service } = makeService(repo);
    await service.addMember('ws-1', { userId: 'user-2' }, 'user-1');
    expect(repo.createMembership).not.toHaveBeenCalled();
  });
});

// ── removeMember ───────────────────────────────────────────────────────────────

describe('WorkspaceService.removeMember', () => {
  it('lança BadRequestException ao tentar remover a si mesmo', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await expect(service.removeMember('ws-1', 'user-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lança NotFoundException quando membro não encontrado', async () => {
    const repo = makeRepo({ findMembership: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.removeMember('ws-1', 'user-2', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lança ForbiddenException quando membro é workspace_admin', async () => {
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValue(
          makeMembership({ userId: 'user-2', role: MembershipRole.workspace_admin }),
        ),
    });
    const { service } = makeService(repo);
    await expect(service.removeMember('ws-1', 'user-2', 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('soft-deleta o membership do membro', async () => {
    const membership = makeMembership({ id: 'm-target', userId: 'user-2' });
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(membership),
      updateMembership: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.removeMember('ws-1', 'user-2', 'user-1');
    expect(repo.updateMembership).toHaveBeenCalledWith(
      'm-target',
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });
});

// ── promoteToAdmin ─────────────────────────────────────────────────────────────

describe('WorkspaceService.promoteToAdmin', () => {
  it('lança NotFoundException quando usuário não é membro do workspace', async () => {
    const repo = makeRepo({ findMembership: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.promoteToAdmin('ws-1', { userId: 'user-2' }, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lança ConflictException quando usuário já é workspace_admin', async () => {
    const repo = makeRepo({
      findMembership: jest
        .fn()
        .mockResolvedValue(
          makeMembership({ userId: 'user-2', role: MembershipRole.workspace_admin }),
        ),
    });
    const { service } = makeService(repo);
    await expect(service.promoteToAdmin('ws-1', { userId: 'user-2' }, 'user-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('atualiza membership existente para workspace_admin', async () => {
    const membership = makeMembership({ id: 'm-1', userId: 'user-2', role: MembershipRole.member });
    const updated = { ...membership, role: MembershipRole.workspace_admin };
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(membership),
      updateMembershipSelect: jest.fn().mockResolvedValue(updated),
    });
    const { service } = makeService(repo);
    const result = await service.promoteToAdmin('ws-1', { userId: 'user-2' }, 'user-1');
    expect(repo.updateMembershipSelect).toHaveBeenCalledWith('m-1', {
      role: MembershipRole.workspace_admin,
    });
    expect(result.role).toBe(MembershipRole.workspace_admin);
  });
});

// ── revokeAdmin ────────────────────────────────────────────────────────────────

describe('WorkspaceService.revokeAdmin', () => {
  it('lança BadRequestException ao tentar revogar o próprio papel', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await expect(service.revokeAdmin('ws-1', 'user-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lança NotFoundException quando usuário não é workspace_admin', async () => {
    const repo = makeRepo({ findMembership: jest.fn().mockResolvedValue(null) });
    const { service } = makeService(repo);
    await expect(service.revokeAdmin('ws-1', 'user-2', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lança BadRequestException quando é o único workspace_admin', async () => {
    const adminMembership = makeMembership({
      userId: 'user-2',
      role: MembershipRole.workspace_admin,
    });
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(adminMembership),
      countMemberships: jest.fn().mockResolvedValue(0),
    });
    const { service } = makeService(repo);
    await expect(service.revokeAdmin('ws-1', 'user-2', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('soft-deleta membership de workspace_admin e cria nova membership como member', async () => {
    const adminMembership = makeMembership({
      id: 'admin-m',
      userId: 'user-2',
      role: MembershipRole.workspace_admin,
    });
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(adminMembership),
      countMemberships: jest.fn().mockResolvedValue(1),
      updateMembership: jest.fn().mockResolvedValue({}),
      createMembership: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.revokeAdmin('ws-1', 'user-2', 'user-1');

    expect(repo.updateMembership).toHaveBeenCalledWith(
      'admin-m',
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
    expect(repo.createMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        resourceType: ResourceType.workspace,
        resourceId: 'ws-1',
        role: MembershipRole.member,
      }),
    );
  });

  it('usuário permanece no workspace após revogação (nova membership como member)', async () => {
    const adminMembership = makeMembership({
      id: 'admin-m',
      userId: 'user-2',
      role: MembershipRole.workspace_admin,
    });
    const repo = makeRepo({
      findMembership: jest.fn().mockResolvedValue(adminMembership),
      countMemberships: jest.fn().mockResolvedValue(2),
      updateMembership: jest.fn().mockResolvedValue({}),
      createMembership: jest.fn().mockResolvedValue({}),
    });
    const { service } = makeService(repo);
    await service.revokeAdmin('ws-1', 'user-2', 'user-1');
    // Verifica que createMembership foi chamado (usuário não foi removido)
    expect(repo.createMembership).toHaveBeenCalledTimes(1);
    expect(repo.createMembership).toHaveBeenCalledWith(
      expect.objectContaining({ role: MembershipRole.member }),
    );
  });
});
