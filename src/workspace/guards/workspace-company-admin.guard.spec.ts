import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceCompanyAdminGuard } from './workspace-company-admin.guard';

function makePrisma(opts: { workspace?: unknown; companyAdmin?: unknown }) {
  return {
    workspace: { findFirst: jest.fn().mockResolvedValue(opts.workspace ?? null) },
    membership: { findFirst: jest.fn().mockResolvedValue(opts.companyAdmin ?? null) },
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

describe('WorkspaceCompanyAdminGuard.canActivate', () => {
  it('Forbidden quando workspaceId ausente', async () => {
    const guard = new WorkspaceCompanyAdminGuard(makePrisma({}));
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('Forbidden quando workspace não encontrado', async () => {
    const guard = new WorkspaceCompanyAdminGuard(makePrisma({ workspace: null }));
    await expect(guard.canActivate(makeContext('ws-1'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('retorna true quando user é admin da company dona do workspace', async () => {
    const guard = new WorkspaceCompanyAdminGuard(
      makePrisma({
        workspace: { companyId: 'c-1' },
        companyAdmin: { id: 'm-1' },
      }),
    );
    expect(await guard.canActivate(makeContext('ws-1'))).toBe(true);
  });

  it('Forbidden quando user é apenas workspace_admin (não company admin)', async () => {
    const guard = new WorkspaceCompanyAdminGuard(
      makePrisma({
        workspace: { companyId: 'c-1' },
        companyAdmin: null,
      }),
    );
    await expect(guard.canActivate(makeContext('ws-1'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
