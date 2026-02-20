import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MailerService } from '../mailer/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmResetPasswordDto } from './dto/confirm-reset-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailerService: MailerService,
    @InjectPinoLogger(AuthService.name)
    private readonly logger: PinoLogger,
  ) {}

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });

    if (!user) {
      this.logger.warn({ email }, 'Login attempt for unknown email');
      return null;
    }

    if (!user.isActive) {
      this.logger.warn({ userId: user.id, email }, 'Login attempt for inactive user');
      throw new UnauthorizedException('Usuário inativo');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      this.logger.warn({ userId: user.id, email }, 'Login attempt with invalid password');
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _, ...result } = user;
    return result;
  }

  login(user: { id: string; email: string; isSuperuser: boolean; mustResetPassword: boolean }) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      isSuperuser: user.isSuperuser,
      mustResetPassword: user.mustResetPassword,
    };

    this.logger.info(
      {
        userId: user.id,
        email: user.email,
        isSuperuser: user.isSuperuser,
        mustResetPassword: user.mustResetPassword,
      },
      'User logged in',
    );

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        isSuperuser: user.isSuperuser,
        mustResetPassword: user.mustResetPassword,
      },
    };
  }

  async resetPassword(userId: string, dto: ResetPasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('As senhas não coincidem');
    }

    const hash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        mustResetPassword: false,
      },
    });

    this.logger.info({ userId }, 'Password changed via first access');
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null, isActive: true },
    });

    if (!user) {
      this.logger.warn({ email }, 'Password reset requested for unknown or inactive email');
      return;
    }

    // Invalida tokens anteriores não utilizados
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const expiresInSeconds = this.configService.get<number>('PASSWORD_RESET_EXPIRES_IN', 3600);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

    await this.mailerService.sendPasswordResetEmail(user.email, resetUrl);

    this.logger.info({ userId: user.id, email, expiresAt }, 'Password reset email sent');
  }

  async confirmResetPassword(rawToken: string, dto: ConfirmResetPasswordDto): Promise<void> {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('As senhas não coincidem');
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!record || record.usedAt !== null || record.expiresAt < new Date()) {
      this.logger.warn(
        { tokenHashPrefix: tokenHash.slice(0, 8) },
        'Invalid or expired reset token used',
      );
      throw new BadRequestException('Token inválido ou expirado');
    }

    const newHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: newHash, mustResetPassword: false },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    this.logger.info({ userId: record.userId }, 'Password reset confirmed');
  }
}
