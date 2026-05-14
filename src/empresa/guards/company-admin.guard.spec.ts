import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CompanyAdminGuard } from './company-admin.guard';

// ── helpers ────────────────────────────────────────────────────────────────────

function makePrisma(opts: { membership?: unknown; company?: unknown }) {
  return {
    membership: { findFirst: jest.fn().mockResolvedValue(opts.membership ?? null) },
    company: { findFirst: jest.fn().mockResolvedValue(opts.company ?? null) },
  } as unknown as PrismaService;
}

function makeContext(opts: { userId?: string; companyId?: string | undefined }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: opts.userId ?? 'u-1' },
        params: opts.companyId === undefined ? {} : { companyId: opts.companyId },
      }),
    }),
  } as unknown as ExecutionContext;
}

// ── canActivate ────────────────────────────────────────────────────────────────

describe('CompanyAdminGuard.canActivate', () => {
  it('lança Forbidden quando companyId está ausente nos params', async () => {
    const guard = new CompanyAdminGuard(makePrisma({}));
    await expect(guard.canActivate(makeContext({ companyId: undefined }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('retorna true quando user é admin direto da empresa ativa', async () => {
    const prisma = makePrisma({
      membership: { id: 'm-1', role: 'admin' },
      company: { id: 'c-1', isActive: true },
    });
    const guard = new CompanyAdminGuard(prisma);
    const result = await guard.canActivate(makeContext({ companyId: 'c-1' }));
    expect(result).toBe(true);
  });

  it('lança Forbidden quando user não tem membership admin', async () => {
    const prisma = makePrisma({ membership: null, company: { id: 'c-1' } });
    const guard = new CompanyAdminGuard(prisma);
    await expect(guard.canActivate(makeContext({ companyId: 'c-1' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lança Forbidden quando empresa não existe ou está inativa', async () => {
    const prisma = makePrisma({ membership: { id: 'm' }, company: null });
    const guard = new CompanyAdminGuard(prisma);
    await expect(guard.canActivate(makeContext({ companyId: 'c-1' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('consulta membership filtrando por role=admin e resourceType=company', async () => {
    const prisma = makePrisma({ membership: { id: 'm' }, company: { id: 'c-1' } });
    const guard = new CompanyAdminGuard(prisma);
    await guard.canActivate(makeContext({ userId: 'u-9', companyId: 'c-1' }));

    expect((prisma as any).membership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u-9',
        resourceType: 'company',
        resourceId: 'c-1',
        role: 'admin',
        deletedAt: null,
      },
    });
  });
});
