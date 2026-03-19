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
import { MoveProjectDto } from './dto/move-project.dto';
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
      icon: dto.icon,
      iconColor: dto.iconColor,
    });

    this.logger.info(
      { workspaceId, projectId: result.project.id, createdById },
      'Project created with default columns',
    );

    return result;
  }

  async listProjects(
    workspaceId: string,
    query: ListProjectsQueryDto,
    isAdmin = false,
    userId?: string,
  ) {
    const { isActive, page = 1, limit = 20 } = query;

    const where: {
      workspaceId: string;
      deletedAt: null;
      isActive?: boolean;
      id?: { notIn: string[] };
    } = { workspaceId, deletedAt: null };

    if (!isAdmin) {
      // Membros regulares só enxergam projetos ativos (RF025)
      where.isActive = true;

      // Filtrar projetos restritos para este usuário
      if (userId) {
        const restricted = await this.repo.findRestrictedProjectIds(workspaceId, userId);
        if (restricted.length > 0) {
          where.id = { notIn: restricted.map((r) => r.projectId) };
        }
      }
    } else if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await this.repo.findProjects(where, page, limit);
    return { data, total, page, limit };
  }

  async getInfo(workspaceId: string) {
    const workspace = await this.repo.findWorkspaceById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');
    return workspace;
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

  async moveProjectToWorkspace(
    workspaceId: string,
    projectId: string,
    dto: MoveProjectDto,
    userId: string,
  ) {
    const { targetWorkspaceId } = dto;

    if (targetWorkspaceId === workspaceId) {
      throw new BadRequestException('O workspace de destino deve ser diferente do atual');
    }

    const project = await this.repo.findProjectById(projectId, workspaceId);
    if (!project) throw new NotFoundException('Projeto não encontrado');

    const workspace = await this.repo.findWorkspaceById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    // Verificar que o workspace de destino pertence à mesma empresa
    const [targetWs] = await this.repo.findWorkspacesByCompany(workspace.companyId, [
      targetWorkspaceId,
    ]);
    if (!targetWs) {
      throw new BadRequestException(
        'Workspace de destino não encontrado ou pertence a outra empresa',
      );
    }

    // Verificar que o usuário é workspace_admin do workspace de origem OU company admin
    const [workspaceAdminMembership, companyAdminMembership] = await Promise.all([
      this.repo.findMembership({
        userId,
        resourceType: ResourceType.workspace,
        resourceId: workspaceId,
        role: MembershipRole.workspace_admin,
        deletedAt: null,
      }),
      this.repo.findMembership({
        userId,
        resourceType: ResourceType.company,
        resourceId: workspace.companyId,
        role: MembershipRole.admin,
        deletedAt: null,
      }),
    ]);
    if (!workspaceAdminMembership && !companyAdminMembership) {
      throw new ForbiddenException(
        'Apenas workspace_admin ou company admin pode mover projetos entre workspaces',
      );
    }

    await this.repo.moveProjectToWorkspace(projectId, targetWorkspaceId);

    this.logger.info(
      { workspaceId, targetWorkspaceId, projectId, userId },
      'Project moved to another workspace',
    );

    return { projectId, newWorkspaceId: targetWorkspaceId };
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

  // ── Visão Geral ───────────────────────────────────────────────────────────────

  async getVisaoGeral(workspaceId: string, userId: string, isAdmin = false) {
    const workspace = await this.repo.findWorkspaceById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    let excludeProjectIds: string[] = [];
    if (!isAdmin) {
      const restricted = await this.repo.findRestrictedProjectIds(workspaceId, userId);
      excludeProjectIds = restricted.map((r) => r.projectId);
    }

    const projects = await this.repo.findProjectsWithTasksForOverview(
      workspaceId,
      excludeProjectIds,
    );

    return projects.map((project) => {
      const prefix = computeTaskPrefix(project.name);

      const columns = project.columns.map((col) => ({
        id: col.id,
        name: col.name,
        color: col.color,
        order: col.order,
        taskCount: col.tasks.length,
        tasks: col.tasks.map((task) => ({
          id: task.id,
          taskNumber: task.taskNumber,
          taskRef: task.taskNumber != null ? `${prefix}-${task.taskNumber}` : null,
          title: task.title,
          priority: task.priority,
          dueDate: task.dueDate,
          startDate: task.startDate,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          columnId: task.columnId,
          assignees: task.taskAssignees.map((a) => a.user),
        })),
      }));

      const totalTasks = columns.reduce((sum, col) => sum + col.taskCount, 0);

      return {
        id: project.id,
        name: project.name,
        icon: project.icon,
        iconColor: project.iconColor,
        taskPrefix: prefix,
        totalTasks,
        columns,
      };
    });
  }

  async resolveTaskRef(workspaceId: string, taskRef: string) {
    const workspace = await this.repo.findWorkspaceById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    // taskRef format: PREFIX-NUMBER (e.g. TS-42)
    const match = /^([A-Z]+)-(\d+)$/i.exec(taskRef.trim());
    if (!match) throw new NotFoundException('Referência de task inválida');

    const taskNumber = parseInt(match[2], 10);
    const prefix = match[1].toUpperCase();

    const task = await this.repo.findTaskByRef(workspaceId, taskNumber);
    if (!task) throw new NotFoundException('Task não encontrada');

    // Validate prefix matches project name
    const expectedPrefix = computeTaskPrefix(task.project.name);
    if (expectedPrefix !== prefix) throw new NotFoundException('Task não encontrada');

    return {
      taskId: task.id,
      projectId: task.projectId,
      taskNumber: task.taskNumber,
      taskRef: `${prefix}-${task.taskNumber}`,
      title: task.title,
    };
  }
}

function computeTaskPrefix(projectName: string): string {
  const words = projectName.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words.map((w) => w[0].toUpperCase()).join('');
  }
  return words[0].slice(0, 3).toUpperCase();
}
