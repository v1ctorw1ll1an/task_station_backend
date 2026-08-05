import {
  BadRequestException,
  ConflictException,
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
import { RegisterColaboradorDto } from './dto/register-colaborador.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { normalizeTaxId } from '../common/tax-id';
import { JwtPayload } from './strategies/jwt.strategy';
import { AuthRepository } from './auth.repository';

// Hash dummy usado para neutralizar timing attack quando o email não existe.
// É um bcrypt válido de uma senha aleatória de 64 bytes — bcrypt.compare leva
// o mesmo tempo (~custo 10) que um hash real, mas nunca bate com nada.
// Pré-computado para evitar custo de geração no boot.
const DUMMY_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

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

    // Constant-time login: roda bcrypt mesmo quando o usuário não existe,
    // contra hash dummy. Sem isso, o tempo de resposta vaza a existência
    // do email (timing attack → enumeração).
    if (!user) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      this.logger.warn({ email }, 'Login attempt for unknown email');
      return null;
    }

    if (!user.isActive) {
      // Também consome bcrypt para igualar timing com usuário válido + senha errada.
      await bcrypt.compare(password, user.passwordHash);
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

  /**
   * Um assento = um login. Cada entrada gera uma sessão nova e a grava no usuário:
   * o token anterior (outro PC, outra aba, outro navegador) para de valer no
   * request seguinte — o último login vence. Ver `JwtStrategy.validate`.
   */
  async login(user: {
    id: string;
    email: string;
    isSuperuser: boolean;
    mustResetPassword: boolean;
  }) {
    const sid = crypto.randomUUID();
    await this.repo.updateUser(user.id, { activeSessionId: sid });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      isSuperuser: user.isSuperuser,
      mustResetPassword: user.mustResetPassword,
      sid,
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
    // A sessão anterior deste usuário acabou de ser derrubada (se existia).

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

  /** Encerra a sessão única: o token que estava em uso deixa de valer na hora. */
  async logout(userId: string): Promise<{ message: string }> {
    await this.repo.updateUser(userId, { activeSessionId: null });
    this.logger.info({ userId }, 'User logged out');
    return { message: 'ok' };
  }

  /**
   * Auto-cadastro público (self-service): cria a empresa + o usuário dono +
   * membership admin + assinatura trial de 7 dias e envia o magic link de
   * primeiro acesso. O dono ativa a conta e define a senha em `/first-access`.
   * Gated por `PUBLIC_SIGNUP_ENABLED`. NÃO retorna o magic link na resposta —
   * a verificação por e-mail (posse da caixa) é o que valida o cadastro.
   */
  async register(dto: RegisterDto): Promise<{ ok: true }> {
    if (this.configService.get<string>('PUBLIC_SIGNUP_ENABLED') !== 'true') {
      throw new NotFoundException('Cannot POST /auth/register');
    }

    const email = dto.email.trim().toLowerCase();
    const taxId = normalizeTaxId(dto.taxId);

    const existingCompany = await this.repo.findCompanyByTaxId(taxId);
    if (existingCompany) {
      throw new ConflictException('Já existe uma empresa com este CNPJ');
    }

    const existingUser = await this.repo.findActiveUserByEmail(email);
    if (existingUser) {
      throw new ConflictException('E-mail já cadastrado. Faça login.');
    }

    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const ownerName = dto.ownerName.trim();

    const { company, owner } = await this.repo.registerCompanyWithOwner(
      { legalName: dto.legalName.trim(), taxId },
      {
        name: ownerName,
        email,
        // Só dígitos, mesmo tratamento do taxId: a máscara é do formulário, não do dado.
        phone: normalizeTaxId(dto.phone),
        passwordHash: placeholderHash,
        mustResetPassword: true,
      },
    );

    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    const rawToken = await this.generateFirstAccessToken(owner.id);
    const magicLink = `${frontendUrl}/first-access?token=${rawToken}`;

    // Em dev, imprime o link no terminal para testar sem depender do email.
    // Nunca em produção — expor o link nos logs permitiria ativar a conta de outrem.
    const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
    if (isDev) {
      this.logger.info(
        { companyId: company.id, ownerId: owner.id, email, magicLink },
        `🔑 [DEV] Link de ativação (auto-cadastro): ${magicLink}`,
      );
    }

    try {
      await this.mailerService.sendFirstAccessEmail(email, ownerName, magicLink);
    } catch (err: unknown) {
      this.logger.error(
        { companyId: company.id, ownerId: owner.id, email, err },
        'Failed to send activation email — company was created successfully',
      );
    }

    this.logger.info(
      { companyId: company.id, ownerId: owner.id, email },
      'Company self-registered (trial started)',
    );

    return { ok: true };
  }

  /**
   * Auto-cadastro público de colaborador: cria SÓ a conta da pessoa — sem empresa,
   * sem membership, sem assinatura. Depois de ativar, ela cai na tela que explica o
   * que pedir ao gerente, e entra na empresa (ou em várias) por convite.
   * Gated por `PUBLIC_SIGNUP_ENABLED`, igual ao cadastro de empresa.
   *
   * Responde `{ ok: true }` mesmo quando o e-mail já existe — aqui não há CNPJ para
   * justificar um 409, e um erro distinguível transformaria a rota em oráculo de
   * enumeração de e-mails. Quem é dono da caixa recebe um aviso explicando.
   */
  async registerColaborador(dto: RegisterColaboradorDto): Promise<{ ok: true }> {
    if (this.configService.get<string>('PUBLIC_SIGNUP_ENABLED') !== 'true') {
      throw new NotFoundException('Cannot POST /auth/register-colaborador');
    }

    const email = dto.email.trim().toLowerCase();
    const name = dto.name.trim();

    const existingUser = await this.repo.findActiveUserByEmail(email);
    if (existingUser) {
      this.logger.warn({ email }, 'Colaborador self-signup for existing email');
      try {
        await this.mailerService.sendAccountAlreadyExistsEmail(email);
      } catch (err: unknown) {
        this.logger.error({ email, err }, 'Failed to send account-already-exists email');
      }
      return { ok: true };
    }

    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const user = await this.repo.createUserWithoutCompany({
      name,
      email,
      passwordHash: placeholderHash,
    });

    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    const rawToken = await this.generateFirstAccessToken(user.id);
    const magicLink = `${frontendUrl}/first-access?token=${rawToken}`;

    // Em dev, imprime o link no terminal para testar sem depender do email.
    // Nunca em produção — expor o link nos logs permitiria ativar a conta de outrem.
    const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
    if (isDev) {
      this.logger.info(
        { userId: user.id, email, magicLink },
        `🔑 [DEV] Link de ativação (colaborador): ${magicLink}`,
      );
    }

    try {
      await this.mailerService.sendFirstAccessEmail(email, name, magicLink);
    } catch (err: unknown) {
      this.logger.error(
        { userId: user.id, email, err },
        'Failed to send activation email — user was created successfully',
      );
    }

    this.logger.info({ userId: user.id, email }, 'Colaborador self-registered (no company)');

    return { ok: true };
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

    // Em dev, imprime o link no terminal para facilitar o teste sem depender do email.
    // Nunca em produção — expor o link nos logs permitiria sequestrar a redefinição de senha.
    const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
    if (isDev) {
      this.logger.info(
        { userId: user.id, email, resetUrl },
        `🔑 [DEV] Link de recuperação de senha: ${resetUrl}`,
      );
    }

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
