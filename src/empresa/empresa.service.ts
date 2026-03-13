import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipRole, ResourceType } from '../generated/prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer/mailer.service';
import { EmpresaRepository } from './empresa.repository';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { ListWorkspacesQueryDto } from './dto/list-workspaces-query.dto';
import { ContratarMembroDto } from './dto/contratar-membro.dto';
import { PromoteMemberDto } from './dto/promote-member.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@Injectable()
export class EmpresaService {
  constructor(
    private readonly repo: EmpresaRepository,
    private readonly mailerService: MailerService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    @InjectPinoLogger(EmpresaService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Workspaces ────────────────────────────────────────────────────────────────

  async createWorkspace(companyId: string, dto: CreateWorkspaceDto, createdById: string) {
    const memberIds = dto.memberIds ?? [];

    const workspace = await this.repo.createWorkspaceWithMembers({
      workspaceName: dto.name,
      workspaceDescription: dto.description,
      companyId,
      createdById,
      memberIds,
    });

    this.logger.info(
      { companyId, workspaceId: workspace.id, memberCount: memberIds.length, createdById },
      'Workspace created',
    );

    return { workspace };
  }

  async listWorkspaces(companyId: string, query: ListWorkspacesQueryDto) {
    const { isActive, page = 1, limit = 20 } = query;

    const where: { companyId: string; deletedAt: null; isActive?: boolean } = {
      companyId,
      deletedAt: null,
    };

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await this.repo.findWorkspaces(where, page, limit);
    return { data, total, page, limit };
  }

  async getWorkspace(companyId: string, workspaceId: string) {
    const workspace = await this.repo.findWorkspaceByIdSelect(workspaceId, companyId);

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    return workspace;
  }

  async updateWorkspace(companyId: string, workspaceId: string, dto: UpdateWorkspaceDto) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const updated = await this.repo.updateWorkspace(workspaceId, dto);
    this.logger.info({ companyId, workspaceId, changes: dto }, 'Workspace updated');
    return updated;
  }

  async deactivateWorkspace(companyId: string, workspaceId: string) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const updated = await this.repo.updateWorkspace(workspaceId, { isActive: false });
    this.logger.info({ companyId, workspaceId }, 'Workspace deactivated');
    return updated;
  }

  async activateWorkspace(companyId: string, workspaceId: string) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const updated = await this.repo.updateWorkspace(workspaceId, { isActive: true });
    this.logger.info({ companyId, workspaceId }, 'Workspace activated');
    return updated;
  }

  async deleteWorkspace(companyId: string, workspaceId: string, performedById: string) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    await this.repo.softDeleteWorkspace(workspaceId);
    this.logger.info({ companyId, workspaceId, performedById }, 'Workspace soft-deleted');
  }

  // ── Membros ───────────────────────────────────────────────────────────────────

  async contratarMembro(companyId: string, dto: ContratarMembroDto, performedById: string) {
    const existing = await this.repo.findUserByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email já cadastrado no sistema');
    }

    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const user = await this.repo.createUserWithCompanyMembership({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      passwordHash: placeholderHash,
      companyId,
    });

    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    const rawToken = await this.authService.generateFirstAccessToken(user.id);
    const magicLink = `${frontendUrl}/first-access?token=${rawToken}`;

    this.mailerService
      .sendFirstAccessEmail(dto.email, dto.name, magicLink)
      .catch((err: unknown) => {
        this.logger.error({ email: dto.email, err }, 'Failed to send first access email');
      });

    this.logger.info({ companyId, userId: user.id, performedById }, 'Member hired to company');
    return user;
  }

  async listMembers(companyId: string, query: ListMembersQueryDto) {
    const { search, isActive, page = 1, limit = 20 } = query;

    const workspaces = await this.repo.findCompanyWorkspaces(companyId);
    const workspaceIds = workspaces.map((w) => w.id);
    const workspaceNameMap = new Map(workspaces.map((w) => [w.id, w.name]));

    const memberships = await this.repo.findMembershipsSelect({
      deletedAt: null,
      OR: [
        { resourceType: 'company', resourceId: companyId },
        ...(workspaceIds.length > 0
          ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
          : []),
      ],
    });

    if (memberships.length === 0) {
      return { data: [], total: 0, page, limit };
    }

    // Consolidar por userId — manter o role mais alto e a data mais antiga
    const roleRank: Record<string, number> = { admin: 3, workspace_admin: 2, member: 1 };
    const consolidatedMap = new Map<string, { id: string; role: string; createdAt: Date }>();
    const workspaceRolesMap = new Map<
      string,
      Array<{ workspaceId: string; workspaceName: string; role: string; membershipId: string }>
    >();

    for (const m of memberships) {
      if (m.resourceType === ResourceType.workspace) {
        const existing = workspaceRolesMap.get(m.userId) ?? [];
        existing.push({
          workspaceId: m.resourceId,
          workspaceName: workspaceNameMap.get(m.resourceId) ?? m.resourceId,
          role: m.role,
          membershipId: m.id,
        });
        workspaceRolesMap.set(m.userId, existing);
      }

      const existingConsolidated = consolidatedMap.get(m.userId);
      const rank = roleRank[m.role] ?? 0;
      if (!existingConsolidated) {
        consolidatedMap.set(m.userId, { id: m.id, role: m.role, createdAt: m.createdAt });
      } else {
        const existingRank = roleRank[existingConsolidated.role] ?? 0;
        if (rank > existingRank) {
          consolidatedMap.set(m.userId, {
            id: m.id,
            role: m.role,
            createdAt: existingConsolidated.createdAt,
          });
        } else if (m.createdAt < existingConsolidated.createdAt) {
          consolidatedMap.set(m.userId, { ...existingConsolidated, createdAt: m.createdAt });
        }
      }
    }

    const userIds = Array.from(consolidatedMap.keys());

    const userWhere: {
      id: { in: string[] };
      deletedAt: null;
      isActive?: boolean;
      OR?: Array<
        | { name: { contains: string; mode: 'insensitive' } }
        | { email: { contains: string; mode: 'insensitive' } }
      >;
    } = { id: { in: userIds }, deletedAt: null };

    if (isActive !== undefined) {
      userWhere.isActive = isActive;
    }

    if (search) {
      userWhere.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await this.repo.findUsers(userWhere, page, limit);

    const data = users.map((u) => {
      const m = consolidatedMap.get(u.id);
      return {
        membershipId: m?.id,
        role: m?.role,
        memberSince: m?.createdAt,
        workspaceRoles: workspaceRolesMap.get(u.id) ?? [],
        user: u,
      };
    });

    return { data, total, page, limit };
  }

  /** Lança ForbiddenException se targetUserId for admin ativo desta empresa */
  private async assertNotCompanyAdmin(companyId: string, targetUserId: string) {
    const isAdmin = await this.repo.findMembership({
      userId: targetUserId,
      resourceType: ResourceType.company,
      resourceId: companyId,
      role: 'admin',
      deletedAt: null,
    });
    if (isAdmin) {
      throw new ForbiddenException(
        'Não é possível alterar os papéis de um administrador da empresa',
      );
    }
  }

  async updateMember(
    companyId: string,
    targetUserId: string,
    dto: { isActive?: boolean },
    performedById: string,
  ) {
    if (targetUserId === performedById) {
      throw new BadRequestException('Não é possível alterar o próprio usuário');
    }

    await this.assertNotCompanyAdmin(companyId, targetUserId);

    const workspaceRows = await this.repo.findCompanyWorkspaceIds(companyId);
    const workspaceIds = workspaceRows.map((w) => w.id);

    const membership = await this.repo.findMembership({
      userId: targetUserId,
      deletedAt: null,
      OR: [
        { resourceType: 'company', resourceId: companyId },
        ...(workspaceIds.length > 0
          ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
          : []),
      ],
    });

    if (!membership) {
      throw new NotFoundException('Membro não encontrado nesta empresa');
    }

    const updated = await this.repo.updateUser(targetUserId, dto);

    this.logger.info(
      { companyId, targetUserId, changes: Object.keys(dto), performedById },
      'Company member updated',
    );
    return updated;
  }

  async removeMember(companyId: string, targetUserId: string, performedById: string) {
    if (targetUserId === performedById) {
      throw new BadRequestException('Não é possível remover a si mesmo da empresa');
    }

    await this.assertNotCompanyAdmin(companyId, targetUserId);

    const workspaceRows = await this.repo.findCompanyWorkspaceIds(companyId);
    const workspaceIds = workspaceRows.map((w) => w.id);

    const result = await this.repo.updateManyMemberships(
      {
        userId: targetUserId,
        deletedAt: null,
        OR: [
          { resourceType: 'company', resourceId: companyId },
          ...(workspaceIds.length > 0
            ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
            : []),
        ],
      },
      { deletedAt: new Date() },
    );

    if (result.count === 0) {
      throw new NotFoundException('Membro não encontrado nesta empresa');
    }

    this.logger.info(
      { companyId, targetUserId, performedById, membershipsRevoked: result.count },
      'Member removed from company and all its workspaces',
    );
  }

  // ── Admins ────────────────────────────────────────────────────────────────────

  async promoteToAdmin(companyId: string, dto: PromoteMemberDto, performedById: string) {
    const { userId } = dto;

    const companyMembership = await this.repo.findMembership({
      userId,
      resourceType: 'company',
      resourceId: companyId,
      deletedAt: null,
    });

    if (!companyMembership) {
      throw new NotFoundException('Usuário não é membro desta empresa');
    }

    const existingAdmin = await this.repo.findMembership({
      userId,
      resourceType: 'company',
      resourceId: companyId,
      role: 'admin',
      deletedAt: null,
    });

    if (existingAdmin) {
      throw new ConflictException('Usuário já é administrador desta empresa');
    }

    const membership = await this.repo.createMembershipSelect({
      userId,
      resourceType: ResourceType.company,
      resourceId: companyId,
      role: MembershipRole.admin,
    });

    this.logger.info(
      { companyId, promotedUserId: userId, performedById },
      'User promoted to company admin',
    );
    return membership;
  }

  async revokeAdmin(companyId: string, targetUserId: string, performedById: string) {
    if (targetUserId === performedById) {
      throw new BadRequestException('Não é possível revogar o próprio papel de administrador');
    }

    const adminMembership = await this.repo.findMembership({
      userId: targetUserId,
      resourceType: 'company',
      resourceId: companyId,
      role: 'admin',
      deletedAt: null,
    });

    if (!adminMembership) {
      throw new NotFoundException('Papel de administrador não encontrado para este usuário');
    }

    const activeAdminsCount = await this.repo.countMemberships({
      resourceType: 'company',
      resourceId: companyId,
      role: 'admin',
      deletedAt: null,
      id: { not: adminMembership.id },
    });

    if (activeAdminsCount === 0) {
      throw new BadRequestException(
        'Não é possível revogar o único administrador. Adicione outro administrador primeiro.',
      );
    }

    await this.repo.updateMembership(adminMembership.id, { deletedAt: new Date() });
    this.logger.info({ companyId, targetUserId, performedById }, 'Company admin role revoked');
  }

  /**
   * Retorna todos os papéis de um membro nesta empresa:
   * - papel na empresa (admin | member | null se veio só via workspace)
   * - papel em cada workspace (workspace_admin | project_admin | member | null se não é membro)
   * - papéis por projeto dentro de cada workspace (project_admin membership + restrições)
   */
  async getMemberRoles(companyId: string, targetUserId: string) {
    const user = await this.repo.findUserById(targetUserId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const workspaces = await this.repo.findCompanyWorkspacesWithActive(companyId);
    const workspaceIds = workspaces.map((w) => w.id);

    const memberships = await this.repo.findMembershipsByUserAndScope(
      targetUserId,
      companyId,
      workspaceIds,
    );

    const companyMembership = memberships.find((m) => m.resourceType === ResourceType.company);
    const workspaceMembershipsMap = new Map(
      memberships
        .filter((m) => m.resourceType === ResourceType.workspace)
        .map((m) => [m.resourceId, m]),
    );

    // Fetch all projects per workspace and project-level memberships/restrictions in parallel
    const projectsByWorkspace = await Promise.all(
      workspaceIds.map((wsId) => this.repo.findProjectsByWorkspace(wsId)),
    );
    const allProjectIds = projectsByWorkspace.flat().map((p) => p.id);

    const [projectMemberships, projectRestrictions] = await Promise.all([
      allProjectIds.length > 0
        ? this.repo.findMemberships({
            userId: targetUserId,
            resourceType: ResourceType.project,
            resourceId: { in: allProjectIds },
            deletedAt: null,
          })
        : Promise.resolve([]),
      allProjectIds.length > 0
        ? this.repo.findProjectRestrictionsByUser(targetUserId, allProjectIds)
        : Promise.resolve([]),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const projectAdminSet = new Set(projectMemberships.map((m) => m.resourceId as string));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const restrictedProjectSet = new Set(projectRestrictions.map((r) => r.projectId as string));

    const workspaceRoles = workspaces.map((ws, i) => {
      const m = workspaceMembershipsMap.get(ws.id);
      const projects = projectsByWorkspace[i].map((p) => ({
        projectId: p.id,
        projectName: p.name,
        isActive: p.isActive,
        isRestricted: restrictedProjectSet.has(p.id),
        isProjectAdmin: projectAdminSet.has(p.id),
      }));

      return {
        workspaceId: ws.id,
        workspaceName: ws.name,
        isActive: ws.isActive,
        membershipId: m?.id ?? null,
        role: m?.role ?? null,
        projects,
      };
    });

    return {
      user,
      companyRole: companyMembership?.role ?? null,
      companyMembershipId: companyMembership?.id ?? null,
      workspaceRoles,
    };
  }

  /**
   * Define o papel de um membro em um workspace específico via dropdown.
   * role: 'workspace_admin' | 'project_admin' | 'member' | null (sem acesso)
   */
  async setWorkspaceMemberRole(
    companyId: string,
    workspaceId: string,
    userId: string,
    role: 'workspace_admin' | 'project_admin' | 'member' | null,
    performedById: string,
  ) {
    await this.assertNotCompanyAdmin(companyId, userId);

    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const existing = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });

    if (role === null) {
      // Sem acesso: remove workspace membership
      if (!existing) return;
      await this.repo.updateMembership(existing.id, { deletedAt: new Date() });
      // Remove project memberships for this workspace's projects
      const projects = await this.repo.findProjectsByWorkspace(workspaceId);
      const projectIds = projects.map((p) => p.id);
      if (projectIds.length > 0) {
        await this.repo.updateManyMemberships(
          {
            userId,
            resourceType: ResourceType.project,
            resourceId: { in: projectIds },
            deletedAt: null,
          },
          { deletedAt: new Date() },
        );
      }
      this.logger.info(
        { companyId, workspaceId, userId, performedById },
        'Workspace access removed',
      );
      return;
    }

    if (existing) {
      if (existing.role === role) return existing;
      const updated = await this.repo.updateMembershipSelect(existing.id, { role });
      this.logger.info(
        { companyId, workspaceId, userId, role, performedById },
        'Workspace role updated',
      );
      return updated;
    }

    // Ensure company membership
    const companyMembership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.company,
      resourceId: companyId,
      deletedAt: null,
    });
    if (!companyMembership) {
      await this.repo.createMembership({
        userId,
        resourceType: ResourceType.company,
        resourceId: companyId,
        role: MembershipRole.member,
      });
    }

    const membership = await this.repo.createMembershipSelect({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: role as MembershipRole,
    });

    this.logger.info(
      { companyId, workspaceId, userId, role, performedById },
      'Workspace membership created',
    );
    return membership;
  }

  async restrictProject(
    companyId: string,
    workspaceId: string,
    projectId: string,
    userId: string,
    performedById: string,
  ) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const existing = await this.repo.findProjectRestriction(userId, projectId);
    if (existing) throw new ConflictException('Restrição já existe para este usuário/projeto');

    await this.repo.createProjectRestriction(userId, projectId);

    // If user is project_admin for this project, revoke that role
    const projectAdminMembership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.project,
      resourceId: projectId,
      deletedAt: null,
    });
    if (projectAdminMembership) {
      await this.repo.updateMembership(projectAdminMembership.id, { deletedAt: new Date() });
    }

    this.logger.info(
      { companyId, workspaceId, projectId, userId, performedById },
      'Project restricted',
    );
  }

  async unrestrictProject(
    companyId: string,
    workspaceId: string,
    projectId: string,
    userId: string,
    performedById: string,
  ) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    await this.repo.deleteProjectRestriction(userId, projectId);
    this.logger.info(
      { companyId, workspaceId, projectId, userId, performedById },
      'Project unrestricted',
    );
  }

  async setProjectAdmin(
    companyId: string,
    workspaceId: string,
    projectId: string,
    userId: string,
    performedById: string,
  ) {
    await this.assertNotCompanyAdmin(companyId, userId);

    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    // User must have workspace membership
    const workspaceMembership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });
    if (!workspaceMembership) throw new NotFoundException('Usuário não é membro deste workspace');

    const existing = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.project,
      resourceId: projectId,
      deletedAt: null,
    });
    if (existing) throw new ConflictException('Usuário já é gerente deste projeto');

    const membership = await this.repo.createMembershipSelect({
      userId,
      resourceType: ResourceType.project,
      resourceId: projectId,
      role: MembershipRole.project_admin,
    });

    this.logger.info(
      { companyId, workspaceId, projectId, userId, performedById },
      'Project admin set',
    );
    return membership;
  }

  async revokeProjectAdmin(
    companyId: string,
    workspaceId: string,
    projectId: string,
    userId: string,
    performedById: string,
  ) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const membership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.project,
      resourceId: projectId,
      role: MembershipRole.project_admin,
      deletedAt: null,
    });
    if (!membership) throw new NotFoundException('Papel de gerente de projeto não encontrado');

    await this.repo.updateMembership(membership.id, { deletedAt: new Date() });
    this.logger.info(
      { companyId, workspaceId, projectId, userId, performedById },
      'Project admin revoked',
    );
  }

  async addWorkspaceMember(
    companyId: string,
    workspaceId: string,
    userId: string,
    performedById: string,
  ) {
    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const existing = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });
    if (existing) throw new ConflictException('Usuário já é membro deste workspace');

    const membership = await this.repo.createMembershipSelect({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: MembershipRole.member,
    });

    // Ensure company membership exists
    const companyMembership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.company,
      resourceId: companyId,
      deletedAt: null,
    });
    if (!companyMembership) {
      await this.repo.createMembership({
        userId,
        resourceType: ResourceType.company,
        resourceId: companyId,
        role: MembershipRole.member,
      });
    }

    this.logger.info(
      { companyId, workspaceId, userId, performedById },
      'Member added to workspace',
    );
    return membership;
  }

  async removeWorkspaceMember(
    companyId: string,
    workspaceId: string,
    userId: string,
    performedById: string,
  ) {
    if (userId === performedById) {
      throw new BadRequestException('Não é possível remover a si mesmo do workspace');
    }

    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const membership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });
    if (!membership) throw new NotFoundException('Membro não encontrado neste workspace');

    if (membership.role === MembershipRole.workspace_admin) {
      throw new ForbiddenException('Revogue o papel de workspace_admin antes de remover o membro');
    }

    await this.repo.updateMembership(membership.id, { deletedAt: new Date() });
    this.logger.info(
      { companyId, workspaceId, userId, performedById },
      'Member removed from workspace',
    );
  }

  async promoteToWorkspaceAdmin(
    companyId: string,
    workspaceId: string,
    userId: string,
    performedById: string,
  ) {
    await this.assertNotCompanyAdmin(companyId, userId);

    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const allWorkspaceRows = await this.repo.findCompanyWorkspaceIds(companyId);
    const allWorkspaceIds = allWorkspaceRows.map((w) => w.id);

    const anyMembership = await this.repo.findMembership({
      userId,
      deletedAt: null,
      OR: [
        { resourceType: ResourceType.company, resourceId: companyId },
        ...(allWorkspaceIds.length > 0
          ? [{ resourceType: ResourceType.workspace, resourceId: { in: allWorkspaceIds } }]
          : []),
      ],
    });
    if (!anyMembership) throw new NotFoundException('Usuário não é membro desta empresa');

    const existing = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });

    if (existing) {
      if (existing.role === 'workspace_admin') {
        throw new ConflictException('Usuário já é administrador deste workspace');
      }
      const updated = await this.repo.updateMembershipSelect(existing.id, {
        role: 'workspace_admin',
      });
      this.logger.info(
        { companyId, workspaceId, userId, performedById },
        'User promoted to workspace_admin (existing membership upgraded)',
      );
      return updated;
    }

    const companyMembership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.company,
      resourceId: companyId,
      deletedAt: null,
    });
    if (!companyMembership) {
      await this.repo.createMembership({
        userId,
        resourceType: ResourceType.company,
        resourceId: companyId,
        role: MembershipRole.member,
      });
    }

    const membership = await this.repo.createMembershipSelect({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: MembershipRole.workspace_admin,
    });

    this.logger.info(
      { companyId, workspaceId, userId, performedById },
      'User promoted to workspace_admin',
    );
    return membership;
  }

  async revokeWorkspaceAdmin(
    companyId: string,
    workspaceId: string,
    targetUserId: string,
    performedById: string,
  ) {
    await this.assertNotCompanyAdmin(companyId, targetUserId);

    const workspace = await this.repo.findWorkspaceById(workspaceId, companyId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const membership = await this.repo.findMembership({
      userId: targetUserId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: 'workspace_admin',
      deletedAt: null,
    });
    if (!membership)
      throw new NotFoundException('Papel de workspace_admin não encontrado para este usuário');

    await this.repo.updateMembership(membership.id, { deletedAt: new Date() });

    this.logger.info(
      { companyId, workspaceId, targetUserId, performedById },
      'Workspace admin role revoked',
    );
  }
}
