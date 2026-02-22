import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(MeService.name)
    private readonly logger: PinoLogger,
  ) {}

  async getMyCompanies(userId: string) {
    // Passo 1: memberships diretas na empresa (qualquer role)
    const companyMemberships = await this.prisma.membership.findMany({
      where: { userId, resourceType: 'company', deletedAt: null },
      select: { resourceId: true, role: true },
    });

    // Passo 2: memberships em workspaces → descobrir empresas associadas
    const workspaceMemberships = await this.prisma.membership.findMany({
      where: { userId, resourceType: 'workspace', deletedAt: null },
      select: { resourceId: true },
    });

    let workspaceCompanyIds: string[] = [];
    if (workspaceMemberships.length > 0) {
      const workspaceIds = workspaceMemberships.map((m) => m.resourceId);
      const workspaces = await this.prisma.workspace.findMany({
        where: { id: { in: workspaceIds }, deletedAt: null },
        select: { companyId: true },
      });
      workspaceCompanyIds = workspaces.map((w) => w.companyId);
    }

    // Unificar companyIds sem duplicatas
    const directIds = new Set(companyMemberships.map((m) => m.resourceId));
    const allCompanyIds = [...new Set([...directIds, ...workspaceCompanyIds])];

    if (allCompanyIds.length === 0) {
      return [];
    }

    // Passo 3: buscar empresas ativas
    const companies = await this.prisma.company.findMany({
      where: { id: { in: allCompanyIds }, deletedAt: null, isActive: true },
      select: { id: true, legalName: true },
      orderBy: { legalName: 'asc' },
    });

    const roleRank: Record<string, number> = { admin: 3, workspace_admin: 2, member: 1 };

    this.logger.info({ userId, count: companies.length }, 'User company list fetched');

    return companies
      .map((c) => {
        const direct = companyMemberships.find((m) => m.resourceId === c.id);
        // Sem membership direto na company → veio via workspace
        const role = direct ? direct.role : 'workspace_admin';
        return { companyId: c.id, legalName: c.legalName, role };
      })
      .sort(
        (a, b) =>
          (roleRank[b.role] ?? 0) - (roleRank[a.role] ?? 0) ||
          a.legalName.localeCompare(b.legalName),
      );
  }
}
