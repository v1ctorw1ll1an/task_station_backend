import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceAdminGuard } from './workspace-admin.guard';

function makePrisma(opts: {
  workspace?: unknown;
  workspaceAdmin?: unknown;
  companyAdmin?: unknown;
}) {
  const findFirstMembership = jest
    .fn()
    .mockResolvedValueOnce(opts.workspaceAdmin ?? null)
    .mockResolvedValueOnce(opts.companyAdmin ?? null);
  return {
    workspace: { findFirst: jest.fn().mockResolvedValue(opts.workspace ?? null) },
    membership: { findFirst: findFirstMembership },
  } as unknown as PrismaService;
}

function makeContext(workspaceId: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: 'u-1' },
        params: workspaceId === undefined ? {} : { workspaceId },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('WorkspaceAdminGuard.canActivate', () => {
  it('Forbidden quando workspaceId ausente', async () => {
    const guard = new WorkspaceAdminGuard(makePrisma({}));
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('Forbidden quando workspace não existe', async () => {
    const guard = new WorkspaceAdminGuard(makePrisma({ workspace: null }));
    await expect(guard.canActivate(makeContext('ws-1'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('retorna true quando user é workspace_admin do workspace', async () => {
    const guard = new WorkspaceAdminGuard(
      makePrisma({
        workspace: { companyId: 'c-1' },
        workspaceAdmin: { id: 'm-1' },
      }),
    );
    expect(await guard.canActivate(makeContext('ws-1'))).toBe(true);
  });

  it('retorna true quando user é admin da empresa dona', async () => {
    const guard = new WorkspaceAdminGuard(
      makePrisma({
        workspace: { companyId: 'c-1' },
        workspaceAdmin: null,
        companyAdmin: { id: 'cm-1' },
      }),
    );
    expect(await guard.canActivate(makeContext('ws-1'))).toBe(true);
  });

  it('Forbidden quando user é apenas member do workspace (sem admin)', async () => {
    const guard = new WorkspaceAdminGuard(
      makePrisma({
        workspace: { companyId: 'c-1' },
        workspaceAdmin: null,
        companyAdmin: null,
      }),
    );
    await expect(guard.canActivate(makeContext('ws-1'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
