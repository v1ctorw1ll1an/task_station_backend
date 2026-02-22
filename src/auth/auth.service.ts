import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { TokenType } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { ConsumeFirstAccessDto } from './dto/consume-first-access.dto';
import { ConfirmResetPasswordDto } from './dto/confirm-reset-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { AuthRepository } from './auth.repository';

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailerService: MailerService,
    @InjectPinoLogger(AuthService.name)
    private readonly logger: PinoLogger,
  ) {}

  async validateUser(email: string, password: string) {
    const user = await this.repo.findActiveUserByEmail(email);

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

    const updateData: { passwordHash: string; mustResetPassword: boolean; name?: string } = {
      passwordHash: hash,
      mustResetPassword: false,
    };

    if (dto.name?.trim()) {
      updateData.name = dto.name.trim();
    }

    await this.repo.updateUser(userId, updateData);

    this.logger.info({ userId, nameProvided: !!dto.name }, 'Password changed via first access');
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.repo.findActiveUserByEmail(email);

    if (!user || !user.isActive) {
      this.logger.warn({ email }, 'Password reset requested for unknown or inactive email');
      return;
    }

    await this.repo.invalidateTokensByType(user.id, TokenType.password_reset);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const expiresInSeconds = this.configService.get<number>('PASSWORD_RESET_EXPIRES_IN', 3600);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    await this.repo.createPasswordResetToken({
      userId: user.id,
      tokenHash,
      type: TokenType.password_reset,
      expiresAt,
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
    const record = await this.repo.findPasswordResetToken(tokenHash);

    if (!record || record.usedAt !== null || record.expiresAt < new Date()) {
      this.logger.warn(
        { tokenHashPrefix: tokenHash.slice(0, 8) },
        'Invalid or expired reset token used',
      );
      throw new BadRequestException('Token inválido ou expirado');
    }

    const newHash = await bcrypt.hash(dto.newPassword, 10);

    await this.repo.resetPasswordWithToken(record.userId, record.id, newHash);

    this.logger.info({ userId: record.userId }, 'Password reset confirmed');
  }

  /** Valida um token de primeiro acesso sem consumi-lo. Retorna email do usuário. */
  async validateFirstAccessToken(rawToken: string): Promise<{ email: string }> {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = await this.repo.findPasswordResetTokenWithUser(tokenHash);

    if (
      !record ||
      record.type !== TokenType.first_access ||
      record.usedAt !== null ||
      record.expiresAt < new Date()
    ) {
      throw new BadRequestException('Token inválido ou expirado');
    }

    return { email: record.user.email };
  }

  /** Gera um token de primeiro acesso para o usuário. Invalida tokens anteriores do mesmo tipo. */
  async generateFirstAccessToken(userId: string): Promise<string> {
    await this.repo.invalidateTokensByType(userId, TokenType.first_access);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const expiresInDays = this.configService.get<number>('FIRST_ACCESS_EXPIRES_DAYS', 7);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    await this.repo.createPasswordResetToken({
      userId,
      tokenHash,
      type: TokenType.first_access,
      expiresAt,
    });

    this.logger.info({ userId, expiresAt }, 'First access token generated');
    return rawToken;
  }

  /**
   * Gera (ou regenera) um token de primeiro acesso para o usuário.
   * Sempre invalida tokens anteriores e cria um novo — usado pelo superadmin.
   * Retorna null se o usuário não tiver mustResetPassword=true.
   */
  async getOrRegenerateFirstAccessToken(userId: string): Promise<string | null> {
    const user = await this.repo.findActiveUserById(userId);

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (!user.mustResetPassword) {
      return null;
    }

    return this.generateFirstAccessToken(userId);
  }

  /** Invalida as credenciais do usuário: seta mustResetPassword=true e gera novo token de primeiro acesso. */
  async invalidateUserCredentials(userId: string, performedById: string): Promise<string> {
    const user = await this.repo.findActiveUserById(userId);

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    await this.repo.updateUser(userId, { mustResetPassword: true });

    const rawToken = await this.generateFirstAccessToken(userId);

    this.logger.info({ userId, performedById }, 'User credentials invalidated by superadmin');
    return rawToken;
  }

  /** Consome um token de primeiro acesso: define nome + senha e retorna JWT de login. */
  async consumeFirstAccessToken(rawToken: string, dto: ConsumeFirstAccessDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('As senhas não coincidem');
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = await this.repo.findPasswordResetToken(tokenHash);

    if (
      !record ||
      record.type !== TokenType.first_access ||
      record.usedAt !== null ||
      record.expiresAt < new Date()
    ) {
      this.logger.warn(
        { tokenHashPrefix: tokenHash.slice(0, 8) },
        'Invalid or expired first access token used',
      );
      throw new BadRequestException('Token inválido ou expirado');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    const user = await this.repo.consumeFirstAccessToken(
      record.userId,
      record.id,
      passwordHash,
      dto.name.trim(),
    );

    this.logger.info({ userId: user.id }, 'First access token consumed — user set password');

    return this.login(user);
  }
}
