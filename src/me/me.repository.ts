import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MeRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUserCompanyMemberships(userId: string) {
    return this.prisma.membership.findMany({
      where: { userId, resourceType: 'company', deletedAt: null },
      select: { resourceId: true, role: true },
    });
  }

  findUserWorkspaceMemberships(userId: string) {
    return this.prisma.membership.findMany({
      where: { userId, resourceType: 'workspace', deletedAt: null },
      select: { resourceId: true, role: true },
    });
  }

  findWorkspacesByIds(ids: string[]) {
    return this.prisma.workspace.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, companyId: true },
    });
  }

  findActiveCompaniesByIds(ids: string[]) {
    return this.prisma.company.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true, legalName: true },
      orderBy: { legalName: 'asc' },
    });
  }

  findActiveWorkspacesByIds(ids: string[]) {
    return this.prisma.workspace.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      select: { id: true, name: true, companyId: true },
      orderBy: { name: 'asc' },
    });
  }

  findUserById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true, photoUrl: true, createdAt: true },
    });
  }

  updateUserById(userId: string, data: { name?: string; phone?: string; photoUrl?: string }) {
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true, phone: true, photoUrl: true, updatedAt: true },
    });
  }

  findUserPasswordHash(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
  }

  updateUserPasswordHash(userId: string, passwordHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }

  private buildUserTasksWhere(
    userId: string,
    companyId: string,
    dueDateFilter?: { gte?: Date; lte?: Date },
    createdAtFilter?: { gte?: Date; lte?: Date },
    dateMode?: string,
  ): Prisma.TaskWhereInput {
    const dateCondition =
      dateMode === 'or' && dueDateFilter && createdAtFilter
        ? { OR: [{ dueDate: dueDateFilter }, { createdAt: createdAtFilter }] }
        : {
            ...(dueDateFilter ? { dueDate: dueDateFilter } : {}),
            ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
          };

    return {
      deletedAt: null,
      taskAssignees: { some: { userId } },
      column: { deletedAt: null, isDone: false },
      project: {
        deletedAt: null,
        isActive: true,
        workspace: { deletedAt: null, isActive: true, companyId },
      },
      ...dateCondition,
    };
  }

  findUserTasksByCompany(
    userId: string,
    companyId: string,
    dueDateFilter?: { gte?: Date; lte?: Date },
    page = 1,
    limit = 20,
    createdAtFilter?: { gte?: Date; lte?: Date },
    dateMode?: string,
  ) {
    return this.prisma.task.findMany({
      where: this.buildUserTasksWhere(userId, companyId, dueDateFilter, createdAtFilter, dateMode),
      select: {
        id: true,
        title: true,
        taskNumber: true,
        priority: true,
        dueDate: true,
        startDate: true,
        createdAt: true,
        column: { select: { id: true, name: true, color: true } },
        project: {
          select: {
            id: true,
            name: true,
            icon: true,
            iconColor: true,
            workspace: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  countUserTasksByCompany(
    userId: string,
    companyId: string,
    dueDateFilter?: { gte?: Date; lte?: Date },
    createdAtFilter?: { gte?: Date; lte?: Date },
    dateMode?: string,
  ) {
    return this.prisma.task.count({
      where: this.buildUserTasksWhere(userId, companyId, dueDateFilter, createdAtFilter, dateMode),
    });
  }

  // ── Sidebar Order ──────────────────────────────────────────────────────────────

  findSidebarOrders(userId: string, companyId: string) {
    return Promise.all([
      this.prisma.userWorkspaceOrder.findMany({
        where: { userId, companyId },
        select: { workspaceId: true, position: true },
      }),
      this.prisma.userProjectOrder.findMany({
        where: { userId, workspace: { companyId } },
        select: { projectId: true, workspaceId: true, position: true },
      }),
    ]);
  }

  upsertWorkspaceOrder(userId: string, companyId: string, workspaceIds: string[]) {
    return this.prisma.$transaction([
      this.prisma.userWorkspaceOrder.deleteMany({ where: { userId, companyId } }),
      this.prisma.userWorkspaceOrder.createMany({
        data: workspaceIds.map((workspaceId, index) => ({
          userId,
          companyId,
          workspaceId,
          position: index,
        })),
      }),
    ]);
  }

  upsertProjectOrder(userId: string, workspaceId: string, projectIds: string[]) {
    return this.prisma.$transaction([
      this.prisma.userProjectOrder.deleteMany({ where: { userId, workspaceId } }),
      this.prisma.userProjectOrder.createMany({
        data: projectIds.map((projectId, index) => ({
          userId,
          workspaceId,
          projectId,
          position: index,
        })),
      }),
    ]);
  }
}
