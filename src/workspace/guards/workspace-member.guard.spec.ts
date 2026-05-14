import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceMemberGuard } from './workspace-member.guard';

function makePrisma(opts: {
  workspace?: unknown;
  workspaceMembership?: unknown;
  companyAdminMembership?: unknown;
}) {
  const findFirstMembership = jest
    .fn()
    .mockResolvedValueOnce(opts.workspaceMembership ?? null)
    .mockResolvedValueOnce(opts.companyAdminMembership ?? null);
  return {
    workspace: { findFirst: jest.fn().mockResolvedValue(opts.workspace ?? null) },
    membership: { findFirst: findFirstMembership },
  } as unknown as PrismaService;
}

function makeRequest(workspaceId: string | undefined): Record<string, unknown> {
  return {
    user: { id: 'u-1' },
    params: workspaceId === undefined ? {} : { workspaceId },
  };
}

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('WorkspaceMemberGuard.canActivate', () => {
  it('lança Forbidden quando workspaceId ausente', async () => {
    const guard = new WorkspaceMemberGuard(makePrisma({}));
    await expect(guard.canActivate(makeContext(makeRequest(undefined)))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lança Forbidden quando workspace não existe (deletado ou inativo)', async () => {
    const guard = new WorkspaceMemberGuard(makePrisma({ workspace: null }));
    await expect(guard.canActivate(makeContext(makeRequest('ws-1')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('retorna true e injeta role quando user é membro do workspace', async () => {
    const prisma = makePrisma({
      workspace: { companyId: 'c-1' },
      workspaceMembership: { role: 'member' },
    });
    const guard = new WorkspaceMemberGuard(prisma);
    const req = makeRequest('ws-1');
    const result = await guard.canActivate(makeContext(req));
    expect(result).toBe(true);
    expect((req as any).workspaceMemberRole).toBe('member');
  });

  it('retorna true como workspace_admin quando user é admin da company (sem membership direto)', async () => {
    const prisma = makePrisma({
      workspace: { companyId: 'c-1' },
      workspaceMembership: null,
      companyAdminMembership: { id: 'admin-m' },
    });
    const guard = new WorkspaceMemberGuard(prisma);
    const req = makeRequest('ws-1');
    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect((req as any).workspaceMemberRole).toBe('workspace_admin');
  });

  it('lança Forbidden quando user não tem nem membership no workspace nem admin da empresa', async () => {
    const prisma = makePrisma({
      workspace: { companyId: 'c-1' },
      workspaceMembership: null,
      companyAdminMembership: null,
    });
    const guard = new WorkspaceMemberGuard(prisma);
    await expect(guard.canActivate(makeContext(makeRequest('ws-1')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
