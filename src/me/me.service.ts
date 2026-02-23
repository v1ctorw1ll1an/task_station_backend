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

  async getMyWorkspaces(userId: string) {
    const workspaceMemberships = await this.repo.findUserWorkspaceMemberships(userId);

    if (workspaceMemberships.length === 0) {
      return [];
    }

    const workspaceIds = workspaceMemberships.map((m) => m.resourceId);
    const workspaces = await this.repo.findActiveWorkspacesByIds(workspaceIds);

    const roleMap = new Map(workspaceMemberships.map((m) => [m.resourceId, m.role]));

    this.logger.info({ userId, count: workspaces.length }, 'User workspace list fetched');

    return workspaces.map((ws) => ({
      workspaceId: ws.id,
      workspaceName: ws.name,
      companyId: ws.companyId,
      role: roleMap.get(ws.id) ?? 'member',
    }));
  }

  async getMyCompanies(userId: string) {
    const companyMemberships = await this.repo.findUserCompanyMemberships(userId);
    const workspaceMemberships = await this.repo.findUserWorkspaceMemberships(userId);

    // Mapa workspaceId → role do usuário naquele workspace
    const workspaceRoleMap = new Map(workspaceMemberships.map((m) => [m.resourceId, m.role]));

    let workspacesByCompany: Array<{ id: string; companyId: string }> = [];
    if (workspaceMemberships.length > 0) {
      const workspaceIds = workspaceMemberships.map((m) => m.resourceId);
      workspacesByCompany = await this.repo.findWorkspacesByIds(workspaceIds);
    }

    // Mapa companyId → melhor role do usuário via workspace
    const workspaceRoleByCompany = new Map<string, string>();
    const roleRank: Record<string, number> = { admin: 3, workspace_admin: 2, member: 1 };

    for (const ws of workspacesByCompany) {
      const wsRole = workspaceRoleMap.get(ws.id) ?? 'member';
      const current = workspaceRoleByCompany.get(ws.companyId);
      if (!current || (roleRank[wsRole] ?? 0) > (roleRank[current] ?? 0)) {
        workspaceRoleByCompany.set(ws.companyId, wsRole);
      }
    }

    const directIds = new Set(companyMemberships.map((m) => m.resourceId));
    const allCompanyIds = [
      ...new Set([...directIds, ...workspacesByCompany.map((w) => w.companyId)]),
    ];

    if (allCompanyIds.length === 0) {
      return [];
    }

    const companies = await this.repo.findActiveCompaniesByIds(allCompanyIds);

    this.logger.info({ userId, count: companies.length }, 'User company list fetched');

    return companies
      .map((c) => {
        const direct = companyMemberships.find((m) => m.resourceId === c.id);
        // Prioridade: membership direto na empresa > role via workspace
        const role = direct ? direct.role : (workspaceRoleByCompany.get(c.id) ?? 'member');
        return { companyId: c.id, legalName: c.legalName, role };
      })
      .sort(
        (a, b) =>
          (roleRank[b.role] ?? 0) - (roleRank[a.role] ?? 0) ||
          a.legalName.localeCompare(b.legalName),
      );
  }
}
