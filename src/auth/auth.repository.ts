import { Injectable } from '@nestjs/common';
import { TokenType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
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
