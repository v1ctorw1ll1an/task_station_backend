import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjetoAdminGuard } from './projeto-admin.guard';

function makePrisma(opts: {
  project?: unknown;
  workspaceAdmin?: unknown;
  projectAdmin?: unknown;
  companyAdmin?: unknown;
}) {
  const findFirstMembership = jest
    .fn()
    .mockResolvedValueOnce(opts.workspaceAdmin ?? null)
    .mockResolvedValueOnce(opts.projectAdmin ?? null)
    .mockResolvedValueOnce(opts.companyAdmin ?? null);
  return {
    project: { findFirst: jest.fn().mockResolvedValue(opts.project ?? null) },
    membership: { findFirst: findFirstMembership },
  } as unknown as PrismaService;
}

function makeContext(projectId: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: 'u-1' },
        params: projectId === undefined ? {} : { projectId },
      }),
    }),
  } as unknown as ExecutionContext;
}

const PROJECT = { workspaceId: 'ws-1', workspace: { companyId: 'c-1' } };

describe('ProjetoAdminGuard.canActivate', () => {
  it('Forbidden quando projectId ausente', async () => {
    const guard = new ProjetoAdminGuard(makePrisma({}));
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('NotFoundException quando projeto não existe', async () => {
    const guard = new ProjetoAdminGuard(makePrisma({ project: null }));
    await expect(guard.canActivate(makeContext('p-1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('retorna true quando user é workspace_admin', async () => {
    const guard = new ProjetoAdminGuard(
      makePrisma({ project: PROJECT, workspaceAdmin: { id: 'm-1' } }),
    );
    expect(await guard.canActivate(makeContext('p-1'))).toBe(true);
  });

  it('retorna true quando user é project_admin', async () => {
    const guard = new ProjetoAdminGuard(
      makePrisma({
        project: PROJECT,
        workspaceAdmin: null,
        projectAdmin: { id: 'pa-1' },
      }),
    );
    expect(await guard.canActivate(makeContext('p-1'))).toBe(true);
  });

  it('retorna true quando user é admin da empresa', async () => {
    const guard = new ProjetoAdminGuard(
      makePrisma({
        project: PROJECT,
        workspaceAdmin: null,
        projectAdmin: null,
        companyAdmin: { id: 'ca-1' },
      }),
    );
    expect(await guard.canActivate(makeContext('p-1'))).toBe(true);
  });

  it('Forbidden quando user não é admin em nenhum nível', async () => {
    const guard = new ProjetoAdminGuard(
      makePrisma({
        project: PROJECT,
        workspaceAdmin: null,
        projectAdmin: null,
        companyAdmin: null,
      }),
    );
    await expect(guard.canActivate(makeContext('p-1'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
