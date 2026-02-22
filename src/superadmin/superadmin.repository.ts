import { Injectable } from '@nestjs/common';
import { MembershipRole, Prisma, ResourceType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SuperadminRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Companies ────────────────────────────────────────────────────────────────

  findCompanyByTaxId(taxId: string) {
    return this.prisma.company.findFirst({ where: { taxId, deletedAt: null } });
  }

  findCompanyByTaxIdExcluding(taxId: string, excludeId: string) {
    return this.prisma.company.findFirst({
      where: { taxId, deletedAt: null, id: { not: excludeId } },
    });
  }

  findCompanyById(id: string) {
    return this.prisma.company.findFirst({ where: { id, deletedAt: null } });
  }

  findCompanyDetail(id: string) {
    return this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        legalName: true,
        taxId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  findCompanies(where: Prisma.CompanyWhereInput, page: number, limit: number) {
    return Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.company.count({ where }),
    ]);
  }

  createCompany(data: { legalName: string; taxId: string; createdById: string }) {
    return this.prisma.company.create({ data });
  }

  updateCompany(id: string, data: Prisma.CompanyUpdateInput) {
    return this.prisma.company.update({ where: { id }, data });
  }

  countWorkspacesByCompany(companyId: string) {
    return this.prisma.workspace.count({ where: { companyId, deletedAt: null } });
  }

  countProjectsByCompany(companyId: string) {
    return this.prisma.project.count({
      where: { workspace: { companyId, deletedAt: null }, deletedAt: null },
    });
  }

  // ── Users ─────────────────────────────────────────────────────────────────────

  findUserByEmail(email: string) {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  findUserByEmailExcluding(email: string, excludeId: string) {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null, id: { not: excludeId } },
    });
  }

  findUserById(id: string) {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  findUserDetail(id: string) {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        isSuperuser: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
        memberships: {
          where: { deletedAt: null, resourceType: 'company' },
          select: { id: true, role: true, resourceType: true, resourceId: true, createdAt: true },
        },
      },
    });
  }

  findUsers(where: Prisma.UserWhereInput, page: number, limit: number) {
    return Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isActive: true,
          isSuperuser: true,
          mustResetPassword: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);
  }

  createUser(data: {
    name: string;
    email: string;
    passwordHash: string;
    mustResetPassword: boolean;
  }) {
    return this.prisma.user.create({
      data,
      select: { id: true, name: true, email: true },
    });
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
        isSuperuser: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
  }

  updateProfile(id: string, data: Record<string, unknown>) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        isSuperuser: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // ── Memberships ───────────────────────────────────────────────────────────────

  findMembership(where: Prisma.MembershipWhereInput) {
    return this.prisma.membership.findFirst({ where });
  }

  findCompanyMemberships(companyId: string) {
    return this.prisma.membership.findMany({
      where: { resourceType: 'company', resourceId: companyId, deletedAt: null },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: {
          select: { id: true, name: true, email: true, phone: true, isActive: true },
        },
      },
      orderBy: { createdAt: 'asc' },
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

  updateMembership(id: string, data: Prisma.MembershipUpdateInput) {
    return this.prisma.membership.update({ where: { id }, data });
  }

  // ── Transactions ──────────────────────────────────────────────────────────────

  createCompanyWithAdmin(
    companyData: { legalName: string; taxId: string; createdById: string },
    existingUserId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({ data: companyData });

      await tx.membership.create({
        data: {
          userId: existingUserId,
          resourceType: ResourceType.company,
          resourceId: company.id,
          role: MembershipRole.admin,
        },
      });

      return company;
    });
  }

  createCompanyWithNewAdmin(
    companyData: { legalName: string; taxId: string; createdById: string },
    adminData: { name: string; email: string; passwordHash: string; mustResetPassword: boolean },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({ data: companyData });

      const admin = await tx.user.create({
        data: adminData,
        select: { id: true, name: true, email: true },
      });

      await tx.membership.create({
        data: {
          userId: admin.id,
          resourceType: ResourceType.company,
          resourceId: company.id,
          role: MembershipRole.admin,
        },
      });

      return { company, admin };
    });
  }

  findCompaniesByIds(ids: string[]) {
    return this.prisma.company.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, legalName: true, taxId: true, isActive: true },
    });
  }
}
