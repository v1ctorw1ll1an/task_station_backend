import { Injectable } from '@nestjs/common';
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
}
