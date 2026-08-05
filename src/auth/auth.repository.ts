import { Injectable } from '@nestjs/common';
import { addDays } from 'date-fns';
import {
  MembershipRole,
  ResourceType,
  SubscriptionStatus,
  TokenType,
} from '../generated/prisma/client';
import { TRIAL_DAYS, TRIAL_SEATS } from '../billing/billing.constants';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });
  }

  findCompanyByTaxId(taxId: string) {
    return this.prisma.company.findFirst({ where: { taxId, deletedAt: null } });
  }

  /**
   * Auto-cadastro: cria dono + empresa + membership admin + assinatura trial de
   * 7 dias numa única transação. O dono é o `createdById` da empresa, por isso o
   * user é criado antes (ordem diferente do fluxo do superadmin). Sem a
   * assinatura trial, o gate de cobrança trata a empresa como sempre gravável.
   */
  registerCompanyWithOwner(
    companyData: { legalName: string; taxId: string },
    ownerData: {
      name: string;
      email: string;
      phone: string;
      passwordHash: string;
      mustResetPassword: boolean;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({
        data: ownerData,
        select: { id: true, name: true, email: true, isSuperuser: true, mustResetPassword: true },
      });

      const company = await tx.company.create({
        data: {
          legalName: companyData.legalName,
          taxId: companyData.taxId,
          createdById: owner.id,
        },
      });

      await tx.membership.create({
        data: {
          userId: owner.id,
          resourceType: ResourceType.company,
          resourceId: company.id,
          role: MembershipRole.admin,
        },
      });

      await tx.subscription.create({
        data: {
          companyId: company.id,
          status: SubscriptionStatus.trial,
          trialEndsAt: addDays(new Date(), TRIAL_DAYS),
          purchasedSeats: TRIAL_SEATS,
        },
      });

      return { company, owner };
    });
  }

  /**
   * Auto-cadastro de colaborador: cria SÓ o usuário — sem empresa, sem membership
   * e sem assinatura. Ele entra em empresa por convite (`CompanyInvite`), e enquanto
   * não entrar em nenhuma cai na tela de instruções para o gerente.
   */
  createUserWithoutCompany(data: { name: string; email: string; passwordHash: string }) {
    return this.prisma.user.create({
      data: { ...data, mustResetPassword: true },
      select: { id: true, name: true, email: true },
    });
  }

  findActiveUserById(id: string) {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
  }

  updateUser(id: string, data: Record<string, unknown>) {
    return this.prisma.user.update({ where: { id }, data });
  }

  invalidateTokensByType(userId: string, type: TokenType) {
    return this.prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null, type },
      data: { usedAt: new Date() },
    });
  }

  createPasswordResetToken(data: {
    userId: string;
    tokenHash: string;
    type: TokenType;
    expiresAt: Date;
  }) {
    return this.prisma.passwordResetToken.create({ data });
  }

  findPasswordResetToken(tokenHash: string) {
    return this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  }

  findPasswordResetTokenWithUser(tokenHash: string) {
    return this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { email: true } } },
    });
  }

  markTokenUsed(id: string) {
    return this.prisma.passwordResetToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }

  resetPasswordWithToken(
    userId: string,
    tokenId: string,
    passwordHash: string,
    extraUserData?: Record<string, unknown>,
  ) {
    return this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, mustResetPassword: false, ...extraUserData },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: tokenId },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  consumeFirstAccessToken(userId: string, tokenId: string, passwordHash: string, name: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustResetPassword: false, name },
        select: { id: true, email: true, isSuperuser: true, mustResetPassword: true },
      });

      await tx.passwordResetToken.update({
        where: { id: tokenId },
        data: { usedAt: new Date() },
      });

      return user;
    });
  }
}
