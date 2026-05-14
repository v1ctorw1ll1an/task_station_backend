import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjetoMemberGuard } from './projeto-member.guard';

function makePrisma(opts: {
  project?: unknown;
  workspaceMembership?: unknown;
  companyAdminMembership?: unknown;
  restriction?: unknown;
}) {
  const findFirstMembership = jest
    .fn()
    .mockResolvedValueOnce(opts.workspaceMembership ?? null)
    .mockResolvedValueOnce(opts.companyAdminMembership ?? null);
  return {
    project: { findFirst: jest.fn().mockResolvedValue(opts.project ?? null) },
    membership: { findFirst: findFirstMembership },
    projectRestriction: {
      findUnique: jest.fn().mockResolvedValue(opts.restriction ?? null),
    },
  } as unknown as PrismaService;
}

function makeRequest(projectId: string | undefined): Record<string, unknown> {
  return {
    user: { id: 'u-1' },
    params: projectId === undefined ? {} : { projectId },
  };
}

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const PROJECT = {
  workspaceId: 'ws-1',
  workspace: { companyId: 'c-1' },
};

describe('ProjetoMemberGuard.canActivate', () => {
  it('Forbidden quando projectId ausente', async () => {
    const guard = new ProjetoMemberGuard(makePrisma({}));
    await expect(guard.canActivate(makeContext(makeRequest(undefined)))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('NotFoundException quando projeto não existe', async () => {
    const guard = new ProjetoMemberGuard(makePrisma({ project: null }));
    await expect(guard.canActivate(makeContext(makeRequest('p-1')))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('Forbidden quando user não tem nem membership no workspace nem admin da empresa', async () => {
    const guard = new ProjetoMemberGuard(
      makePrisma({ project: PROJECT, workspaceMembership: null, companyAdminMembership: null }),
    );
    await expect(guard.canActivate(makeContext(makeRequest('p-1')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('company admin sem workspace membership recebe role workspace_admin e bypassa restrictions', async () => {
    const prisma = makePrisma({
      project: PROJECT,
      workspaceMembership: null,
      companyAdminMembership: { id: 'cm-1' },
      restriction: { userId: 'u-1', projectId: 'p-1' },
    });
    const guard = new ProjetoMemberGuard(prisma);
    const req = makeRequest('p-1');
    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect((req as any).projectMemberRole).toBe('workspace_admin');
    expect((prisma as any).projectRestriction.findUnique).not.toHaveBeenCalled();
  });

  it('workspace_admin bypassa restrictions', async () => {
    const prisma = makePrisma({
      project: PROJECT,
      workspaceMembership: { role: 'workspace_admin' },
      restriction: { userId: 'u-1', projectId: 'p-1' },
    });
    const guard = new ProjetoMemberGuard(prisma);
    const req = makeRequest('p-1');
    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect((req as any).projectMemberRole).toBe('workspace_admin');
    expect((prisma as any).projectRestriction.findUnique).not.toHaveBeenCalled();
  });

  it('member com restriction lança Forbidden', async () => {
    const prisma = makePrisma({
      project: PROJECT,
      workspaceMembership: { role: 'member' },
      restriction: { userId: 'u-1', projectId: 'p-1' },
    });
    const guard = new ProjetoMemberGuard(prisma);
    await expect(guard.canActivate(makeContext(makeRequest('p-1')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('member sem restriction passa e injeta role member', async () => {
    const prisma = makePrisma({
      project: PROJECT,
      workspaceMembership: { role: 'member' },
      restriction: null,
    });
    const guard = new ProjetoMemberGuard(prisma);
    const req = makeRequest('p-1');
    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect((req as any).projectMemberRole).toBe('member');
  });
});
