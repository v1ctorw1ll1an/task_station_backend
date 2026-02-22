import { Injectable } from '@nestjs/common';
import { MembershipRole, Prisma, ResourceType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EmpresaRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Users ─────────────────────────────────────────────────────────────────────

  findUserByEmail(email: string) {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

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
          mustResetPassword: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);
  }

  updateUser(id: string, data: Record<string, unknown>) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // ── Workspaces ────────────────────────────────────────────────────────────────

  findWorkspaceById(workspaceId: string, companyId: string) {
    return this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
    });
  }

  findWorkspaceByIdSelect(workspaceId: string, companyId: string) {
    return this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  findWorkspaces(
    where: { companyId: string; deletedAt: null; isActive?: boolean },
    page: number,
    limit: number,
  ) {
    return Promise.all([
      this.prisma.workspace.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          description: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.workspace.count({ where }),
    ]);
  }

  updateWorkspace(id: string, data: Prisma.WorkspaceUpdateInput) {
    return this.prisma.workspace.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  softDeleteWorkspace(id: string) {
    return this.prisma.workspace.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  findCompanyWorkspaceIds(companyId: string) {
    return this.prisma.workspace.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true },
    });
  }

  findCompanyWorkspaces(companyId: string) {
    return this.prisma.workspace.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true },
    });
  }

  findCompanyWorkspacesWithActive(companyId: string) {
    return this.prisma.workspace.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── Memberships ───────────────────────────────────────────────────────────────

  findMembership(where: Prisma.MembershipWhereInput) {
    return this.prisma.membership.findFirst({ where });
  }

  findMemberships(where: Prisma.MembershipWhereInput) {
    return this.prisma.membership.findMany({ where });
  }

  findMembershipsSelect(where: Prisma.MembershipWhereInput) {
    return this.prisma.membership.findMany({
      where,
      select: {
        id: true,
        role: true,
        userId: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
      },
    });
  }

  findMembershipsByUserAndScope(userId: string, companyId: string, workspaceIds: string[]) {
    return this.prisma.membership.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [
          { resourceType: ResourceType.company, resourceId: companyId },
          ...(workspaceIds.length > 0
            ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
            : []),
        ],
      },
      select: { id: true, resourceType: true, resourceId: true, role: true },
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
    return this.prisma.membership.create({
      data,
      select: {
        id: true,
        userId: true,
        role: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
      },
    });
  }

  updateMembership(id: string, data: Prisma.MembershipUpdateInput) {
    return this.prisma.membership.update({ where: { id }, data });
  }

  updateMembershipSelect(id: string, data: Prisma.MembershipUpdateInput) {
    return this.prisma.membership.update({
      where: { id },
      data,
      select: { id: true, userId: true, role: true, resourceId: true, createdAt: true },
    });
  }

  updateManyMemberships(where: Prisma.MembershipWhereInput, data: Prisma.MembershipUpdateInput) {
    return this.prisma.membership.updateMany({ where, data });
  }

  // ── Transactions ──────────────────────────────────────────────────────────────

  createWorkspaceWithNewAdmin(params: {
    workspaceName: string;
    workspaceDescription?: string;
    companyId: string;
    createdById: string;
    adminEmail: string;
    adminName: string;
    adminPasswordHash: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: params.workspaceName,
          description: params.workspaceDescription,
          companyId: params.companyId,
          createdById: params.createdById,
        },
      });

      const admin = await tx.user.create({
        data: {
          name: params.adminName,
          email: params.adminEmail,
          passwordHash: params.adminPasswordHash,
          mustResetPassword: true,
        },
      });

      await tx.membership.create({
        data: {
          userId: admin.id,
          resourceType: ResourceType.company,
          resourceId: params.companyId,
          role: MembershipRole.member,
        },
      });

      await tx.membership.create({
        data: {
          userId: admin.id,
          resourceType: ResourceType.workspace,
          resourceId: workspace.id,
          role: MembershipRole.workspace_admin,
        },
      });

      return { workspace, admin };
    });
  }

  createWorkspaceWithExistingAdmin(params: {
    workspaceName: string;
    workspaceDescription?: string;
    companyId: string;
    createdById: string;
    adminUserId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: params.workspaceName,
          description: params.workspaceDescription,
          companyId: params.companyId,
          createdById: params.createdById,
        },
      });

      await tx.membership.create({
        data: {
          userId: params.adminUserId,
          resourceType: ResourceType.workspace,
          resourceId: workspace.id,
          role: MembershipRole.workspace_admin,
        },
      });

      return workspace;
    });
  }
}
