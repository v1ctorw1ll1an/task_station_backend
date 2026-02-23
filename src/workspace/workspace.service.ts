import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole, Prisma, ResourceType } from '../generated/prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { WorkspaceRepository } from './workspace.repository';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { ListWorkspaceMembersQueryDto } from './dto/list-workspace-members-query.dto';
import { PromoteWorkspaceAdminDto } from './dto/promote-workspace-admin.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    @InjectPinoLogger(WorkspaceService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Projetos ──────────────────────────────────────────────────────────────────

  async createProject(workspaceId: string, dto: CreateProjectDto, createdById: string) {
    const result = await this.repo.createProjectWithColumns({
      workspaceId,
      name: dto.name,
      description: dto.description,
      createdById,
    });

    this.logger.info(
      { workspaceId, projectId: result.project.id, createdById },
      'Project created with default columns',
    );

    return result;
  }

  async listProjects(workspaceId: string, query: ListProjectsQueryDto, isAdmin = false) {
    const { isActive, page = 1, limit = 20 } = query;

    const where: { workspaceId: string; deletedAt: null; isActive?: boolean } = {
      workspaceId,
      deletedAt: null,
    };

    if (!isAdmin) {
      // Membros regulares só enxergam projetos ativos (RF025)
      where.isActive = true;
    } else if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await this.repo.findProjects(where, page, limit);
    return { data, total, page, limit };
  }

  async getProject(workspaceId: string, projectId: string) {
    const project = await this.repo.findProjectByIdSelect(projectId, workspaceId);

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    return project;
  }

  async updateProject(workspaceId: string, projectId: string, dto: UpdateProjectDto) {
    const project = await this.repo.findProjectById(projectId, workspaceId);

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const updated = await this.repo.updateProject(projectId, dto as Prisma.ProjectUpdateInput);
    this.logger.info({ workspaceId, projectId, changes: dto }, 'Project updated');
    return updated;
  }

  async deactivateProject(workspaceId: string, projectId: string) {
    const project = await this.repo.findProjectById(projectId, workspaceId);

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const updated = await this.repo.updateProject(projectId, { isActive: false });
    this.logger.info({ workspaceId, projectId }, 'Project deactivated');
    return updated;
  }

  async activateProject(workspaceId: string, projectId: string) {
    const project = await this.repo.findProjectById(projectId, workspaceId);

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const updated = await this.repo.updateProject(projectId, { isActive: true });
    this.logger.info({ workspaceId, projectId }, 'Project activated');
    return updated;
  }

  async deleteProject(workspaceId: string, projectId: string, performedById: string) {
    const project = await this.repo.findProjectById(projectId, workspaceId);

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    await this.repo.softDeleteProjectCascade(projectId);
    this.logger.info({ workspaceId, projectId, performedById }, 'Project soft-deleted (cascade)');
  }

  // ── Membros ───────────────────────────────────────────────────────────────────

  async listMembers(workspaceId: string, query: ListWorkspaceMembersQueryDto) {
    const { search, isActive, page = 1, limit = 20 } = query;

    const allMemberships = await this.repo.findMemberships({
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });

    if (allMemberships.length === 0) {
      return { data: [], total: 0, page, limit };
    }

    const membershipMap = new Map(allMemberships.map((m) => [m.userId, m]));
    const userIds = Array.from(membershipMap.keys());

    const userWhere: Prisma.UserWhereInput & {
      id: { in: string[] };
      deletedAt: null;
      isActive?: boolean;
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
      const m = membershipMap.get(u.id);
      return {
        membershipId: m?.id,
        role: m?.role,
        memberSince: m?.createdAt,
        user: u,
      };
    });

    return { data, total, page, limit };
  }

  async addMember(workspaceId: string, dto: AddWorkspaceMemberDto, performedById: string) {
    const { userId } = dto;

    const workspace = await this.repo.findWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const existing = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });

    if (existing) {
      throw new ConflictException('Usuário já é membro deste workspace');
    }

    const membership = await this.repo.createMembershipSelect({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: MembershipRole.member,
    });

    // Garante membership na empresa-pai
    const companyMembership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.company,
      resourceId: workspace.companyId,
      deletedAt: null,
    });

    if (!companyMembership) {
      await this.repo.createMembership({
        userId,
        resourceType: ResourceType.company,
        resourceId: workspace.companyId,
        role: MembershipRole.member,
      });
    }

    this.logger.info({ workspaceId, userId, performedById }, 'Member added to workspace');

    return membership;
  }

  async removeMember(workspaceId: string, userId: string, performedById: string) {
    if (userId === performedById) {
      throw new BadRequestException('Não é possível remover a si mesmo do workspace');
    }

    const membership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });

    if (!membership) {
      throw new NotFoundException('Membro não encontrado neste workspace');
    }

    if (membership.role === MembershipRole.workspace_admin) {
      throw new ForbiddenException('Revogue o papel de administrador antes de remover o membro');
    }

    await this.repo.updateMembership(membership.id, { deletedAt: new Date() });

    this.logger.info({ workspaceId, userId, performedById }, 'Member removed from workspace');
  }

  // ── Admins ────────────────────────────────────────────────────────────────────

  async promoteToAdmin(workspaceId: string, dto: PromoteWorkspaceAdminDto, performedById: string) {
    const { userId } = dto;

    const membership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      deletedAt: null,
    });

    if (!membership) {
      throw new NotFoundException('Usuário não é membro deste workspace');
    }

    if (membership.role === MembershipRole.workspace_admin) {
      throw new ConflictException('Usuário já é administrador deste workspace');
    }

    const updated = await this.repo.updateMembershipSelect(membership.id, {
      role: MembershipRole.workspace_admin,
    });

    this.logger.info(
      { workspaceId, promotedUserId: userId, performedById },
      'User promoted to workspace_admin',
    );

    return updated;
  }

  async revokeAdmin(workspaceId: string, userId: string, performedById: string) {
    if (userId === performedById) {
      throw new BadRequestException('Não é possível revogar o próprio papel de administrador');
    }

    const adminMembership = await this.repo.findMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: MembershipRole.workspace_admin,
      deletedAt: null,
    });

    if (!adminMembership) {
      throw new NotFoundException('Papel de workspace_admin não encontrado para este usuário');
    }

    const remainingAdmins = await this.repo.countMemberships({
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: MembershipRole.workspace_admin,
      deletedAt: null,
      id: { not: adminMembership.id },
    });

    if (remainingAdmins === 0) {
      throw new BadRequestException(
        'Não é possível revogar o único administrador. Adicione outro administrador primeiro.',
      );
    }

    // Soft-deleta o membership de workspace_admin e cria um novo como member
    await this.repo.updateMembership(adminMembership.id, { deletedAt: new Date() });
    await this.repo.createMembership({
      userId,
      resourceType: ResourceType.workspace,
      resourceId: workspaceId,
      role: MembershipRole.member,
    });

    this.logger.info(
      { workspaceId, userId, performedById },
      'Workspace admin role revoked, user downgraded to member',
    );
  }
}
