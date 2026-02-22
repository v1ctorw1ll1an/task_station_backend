import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MeRepository } from './me.repository';

@Injectable()
export class MeService {
  constructor(
    private readonly repo: MeRepository,
    @InjectPinoLogger(MeService.name)
    private readonly logger: PinoLogger,
  ) {}

  async getMyCompanies(userId: string) {
    const companyMemberships = await this.repo.findUserCompanyMemberships(userId);
    const workspaceMemberships = await this.repo.findUserWorkspaceMemberships(userId);

    let workspaceCompanyIds: string[] = [];
    if (workspaceMemberships.length > 0) {
      const workspaceIds = workspaceMemberships.map((m) => m.resourceId);
      const workspaces = await this.repo.findWorkspacesByIds(workspaceIds);
      workspaceCompanyIds = workspaces.map((w) => w.companyId);
    }

    const directIds = new Set(companyMemberships.map((m) => m.resourceId));
    const allCompanyIds = [...new Set([...directIds, ...workspaceCompanyIds])];

    if (allCompanyIds.length === 0) {
      return [];
    }

    const companies = await this.repo.findActiveCompaniesByIds(allCompanyIds);

    const roleRank: Record<string, number> = { admin: 3, workspace_admin: 2, member: 1 };

    this.logger.info({ userId, count: companies.length }, 'User company list fetched');

    return companies
      .map((c) => {
        const direct = companyMemberships.find((m) => m.resourceId === c.id);
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
