import { Injectable } from '@nestjs/common';
import { MembershipRole, ResourceType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConviteRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCompanyById(companyId: string) {
    return this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null, isActive: true },
      select: { id: true, legalName: true },
    });
  }

  findActiveUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, email: true, isActive: true },
    });
  }

  /** Membership ativa de empresa — usada para barrar convite a quem já é membro. */
  findCompanyMembership(userId: string, companyId: string) {
    return this.prisma.membership.findFirst({
      where: {
        userId,
        resourceType: ResourceType.company,
        resourceId: companyId,
        deletedAt: null,
      },
    });
  }

  /**
   * Revoga os convites pendentes de `(companyId, email)`. Chamado antes de criar um
   * novo: garante no máximo um convite válido por par sem depender de índice único
   * parcial (que o Prisma não modela).
   */
  revokePendingForEmail(companyId: string, email: string) {
    return this.prisma.companyInvite.updateMany({
      where: { companyId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  create(data: {
    companyId: string;
    email: string;
    tokenHash: string;
    role: MembershipRole;
    invitedById: string;
    expiresAt: Date;
  }) {
    return this.prisma.companyInvite.create({ data });
  }

  findByTokenHash(tokenHash: string) {
    return this.prisma.companyInvite.findUnique({
      where: { tokenHash },
      include: {
        company: { select: { id: true, legalName: true, isActive: true, deletedAt: true } },
      },
    });
  }

  findPendingByCompany(companyId: string) {
    return this.prisma.companyInvite.findMany({
      where: { companyId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        invitedBy: { select: { id: true, name: true } },
      },
    });
  }

  findPendingById(companyId: string, inviteId: string) {
    return this.prisma.companyInvite.findFirst({
      where: { id: inviteId, companyId, acceptedAt: null, revokedAt: null },
    });
  }

  revokeById(inviteId: string) {
    return this.prisma.companyInvite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Aceite: cria a membership e marca o convite consumido na MESMA transação —
   * meio caminho aqui seria acesso sem convite ou convite queimado sem acesso.
   * O `updateMany` filtrando por pendente é o que impede aceite duplo em corrida:
   * a segunda transação atualiza 0 linhas e aborta.
   */
  async accept(params: {
    inviteId: string;
    companyId: string;
    userId: string;
    role: MembershipRole;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.companyInvite.updateMany({
        where: { id: params.inviteId, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date(), acceptedById: params.userId },
      });

      if (count === 0) return false;

      const existing = await tx.membership.findFirst({
        where: {
          userId: params.userId,
          resourceType: ResourceType.company,
          resourceId: params.companyId,
          deletedAt: null,
        },
      });

      if (!existing) {
        await tx.membership.create({
          data: {
            userId: params.userId,
            resourceType: ResourceType.company,
            resourceId: params.companyId,
            role: params.role,
          },
        });
      }

      return true;
    });
  }
}
