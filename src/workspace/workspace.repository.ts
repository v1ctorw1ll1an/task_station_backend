import { Injectable } from '@nestjs/common';
import { MembershipRole, Prisma, ResourceType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PROJECT_SELECT = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  icon: true,
  iconColor: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MEMBERSHIP_SELECT = {
  id: true,
  userId: true,
  role: true,
  resourceType: true,
  resourceId: true,
  createdAt: true,
} as const;

@Injectable()
export class WorkspaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Workspace ─────────────────────────────────────────────────────────────────

  findWorkspaceById(workspaceId: string) {
    return this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, companyId: true, isActive: true },
    });
  }

  findWorkspaceCompanyId(workspaceId: string) {
    return this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { companyId: true },
    });
  }

  // ── Projects ──────────────────────────────────────────────────────────────────

  findProjectById(projectId: string, workspaceId: string) {
    return this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
    });
  }

  findProjectByIdSelect(projectId: string, workspaceId: string) {
    return this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: PROJECT_SELECT,
    });
  }

  findRestrictedProjectIds(workspaceId: string, userId: string) {
    return this.prisma.projectRestriction.findMany({
      where: { userId, project: { workspaceId, deletedAt: null } },
      select: { projectId: true },
    });
  }

  findProjects(
    where: { workspaceId: string; deletedAt: null; isActive?: boolean; id?: { notIn: string[] } },
    page: number,
    limit: number,
  ) {
    return Promise.all([
      this.prisma.project.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: PROJECT_SELECT,
      }),
      this.prisma.project.count({ where }),
    ]);
  }

  updateProject(id: string, data: Prisma.ProjectUpdateInput) {
    return this.prisma.project.update({
      where: { id },
      data,
      select: PROJECT_SELECT,
    });
  }

  createProjectWithColumns(params: {
    workspaceId: string;
    name: string;
    description?: string;
    createdById: string;
    icon?: string;
    iconColor?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          workspaceId: params.workspaceId,
          name: params.name,
          description: params.description,
          createdById: params.createdById,
          icon: params.icon,
          iconColor: params.iconColor,
        },
        select: PROJECT_SELECT,
      });

      const columns = await Promise.all([
        tx.column.create({
          data: { projectId: project.id, name: 'A Fazer', order: 1, color: '#6366f1' },
        }),
        tx.column.create({
          data: { projectId: project.id, name: 'Em Progresso', order: 2, color: '#3b82f6' },
        }),
        tx.column.create({
          data: {
            projectId: project.id,
            name: 'Concluído',
            order: 3,
            color: '#22c55e',
            isDone: true,
          },
        }),
      ]);

      return { project, columns };
    });
  }

  softDeleteProjectCascade(projectId: string) {
    const now = new Date();
    return this.prisma.$transaction([
      this.prisma.task.updateMany({
        where: { projectId, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.column.updateMany({
        where: { projectId, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.project.update({
        where: { id: projectId },
        data: { deletedAt: now },
      }),
    ]);
  }

  // ── Memberships ───────────────────────────────────────────────────────────────

  findMembership(where: Prisma.MembershipWhereInput) {
    return this.prisma.membership.findFirst({ where });
  }

  findMemberships(where: Prisma.MembershipWhereInput) {
    return this.prisma.membership.findMany({
      where,
      select: { id: true, userId: true, role: true, createdAt: true },
    });
  }

  countMemberships(where: Prisma.MembershipWhereInput) {
    return this.prisma.membership.count({ where });
  }

  createMembership(data: {
    userId: string;
    resourceType: ResourceType;
    resourceId: string;
    role: MembershipRole;
  }) {
    return this.prisma.membership.create({ data });
  }

  createMembershipSelect(data: {
    userId: string;
    resourceType: ResourceType;
    resourceId: string;
    role: MembershipRole;
  }) {
    return this.prisma.membership.create({ data, select: MEMBERSHIP_SELECT });
  }

  updateMembership(id: string, data: Prisma.MembershipUpdateInput) {
    return this.prisma.membership.update({ where: { id }, data });
  }

  updateMembershipSelect(id: string, data: Prisma.MembershipUpdateInput) {
    return this.prisma.membership.update({
      where: { id },
      data,
      select: MEMBERSHIP_SELECT,
    });
  }

  // ── Users ─────────────────────────────────────────────────────────────────────

  findUserById(id: string) {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, email: true, phone: true, isActive: true },
    });
  }

  findUsers(where: Prisma.UserWhereInput, page: number, limit: number) {
    return Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isActive: true,
          photoUrl: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);
  }

  // ── Visão Geral ───────────────────────────────────────────────────────────────

  findProjectsWithTasksForOverview(workspaceId: string, excludeProjectIds: string[] = []) {
    return this.prisma.project.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        isActive: true,
        ...(excludeProjectIds.length > 0 ? { id: { notIn: excludeProjectIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        icon: true,
        iconColor: true,
        columns: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
          select: {
            id: true,
            name: true,
            color: true,
            order: true,
            tasks: {
              where: { deletedAt: null },
              orderBy: { taskNumber: 'asc' },
              select: {
                id: true,
                taskNumber: true,
                title: true,
                priority: true,
                dueDate: true,
                startDate: true,
                createdAt: true,
                updatedAt: true,
                columnId: true,
                taskAssignees: {
                  select: {
                    user: { select: { id: true, name: true, photoUrl: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  findWorkspacesByCompany(companyId: string, workspaceIds: string[]) {
    return this.prisma.workspace.findMany({
      where: { id: { in: workspaceIds }, companyId, deletedAt: null },
      select: { id: true },
    });
  }

  moveProjectToWorkspace(projectId: string, targetWorkspaceId: string) {
    return this.prisma.$transaction([
      this.prisma.project.update({
        where: { id: projectId },
        data: { workspaceId: targetWorkspaceId },
      }),
      this.prisma.userProjectOrder.deleteMany({ where: { projectId } }),
    ]);
  }

  findTaskByRef(workspaceId: string, taskNumber: number) {
    return this.prisma.task.findFirst({
      where: {
        taskNumber,
        deletedAt: null,
        project: { workspaceId, deletedAt: null, isActive: true },
      },
      select: {
        id: true,
        taskNumber: true,
        title: true,
        projectId: true,
        columnId: true,
        project: { select: { id: true, name: true } },
      },
    });
  }
}
