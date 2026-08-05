import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { BillingAccessService } from '../billing/billing-access.service';
import { BillingService } from '../billing/billing.service';
import { MembershipRole } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { ConviteRepository } from './convite.repository';

/** Situação de um convite do ponto de vista de quem abriu o link. */
export type ConviteStatus = 'valid' | 'expired' | 'revoked' | 'accepted' | 'not_found';

export interface ConvitePreview {
  status: ConviteStatus;
  companyName: string | null;
  email: string | null;
}

export interface ConviteCriado {
  inviteId: string;
  email: string;
  expiresAt: Date;
  emailSent: boolean;
  inviteLink: string;
}

@Injectable()
export class ConviteService {
  constructor(
    private readonly repo: ConviteRepository,
    private readonly configService: ConfigService,
    private readonly mailerService: MailerService,
    private readonly billingService: BillingService,
    private readonly billingAccess: BillingAccessService,
    @InjectPinoLogger(ConviteService.name)
    private readonly logger: PinoLogger,
  ) {}

  private get expiresInDays(): number {
    return this.configService.get<number>('COMPANY_INVITE_EXPIRES_DAYS', 7);
  }

  private hash(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /** Normaliza igual ao cadastro para o convite casar com o e-mail de quem loga. */
  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Cria (ou reenvia) um convite para entrar na empresa. Verifica assento aqui para
   * o admin descobrir na hora que está sem assento — mas a checagem que vale é a do
   * aceite: convite pendente NÃO reserva assento.
   */
  async criarConvite(params: {
    companyId: string;
    email: string;
    role?: MembershipRole;
    invitedById: string;
  }): Promise<ConviteCriado> {
    const email = ConviteService.normalizeEmail(params.email);
    const role = params.role ?? MembershipRole.member;

    const company = await this.repo.findCompanyById(params.companyId);
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    await this.billingService.assertSeatAvailable(params.companyId);

    const existingUser = await this.repo.findActiveUserByEmail(email);
    if (existingUser) {
      const membership = await this.repo.findCompanyMembership(existingUser.id, params.companyId);
      if (membership) {
        throw new ConflictException('Esta pessoa já faz parte da empresa');
      }
    }

    await this.repo.revokePendingForEmail(params.companyId, email);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.expiresInDays * 24 * 60 * 60 * 1000);

    const invite = await this.repo.create({
      companyId: params.companyId,
      email,
      tokenHash: this.hash(rawToken),
      role,
      invitedById: params.invitedById,
      expiresAt,
    });

    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    const inviteLink = `${frontendUrl}/convite/${rawToken}`;

    // Em dev, imprime o link no terminal para testar sem depender do email. Nunca em
    // produção — o link é a credencial de entrada na empresa.
    if (this.configService.get<string>('NODE_ENV') !== 'production') {
      this.logger.info(
        { companyId: params.companyId, email, inviteLink },
        `🔑 [DEV] Link de convite: ${inviteLink}`,
      );
    }

    let emailSent = false;
    try {
      await this.mailerService.sendCompanyInviteEmail(
        email,
        company.legalName,
        inviteLink,
        this.expiresInDays,
      );
      emailSent = true;
    } catch (err: unknown) {
      this.logger.error(
        { companyId: params.companyId, email, err },
        'Failed to send company invite email — invite was created successfully',
      );
    }

    this.logger.info(
      { companyId: params.companyId, inviteId: invite.id, email, emailSent },
      'Company invite created',
    );

    return { inviteId: invite.id, email, expiresAt, emailSent, inviteLink };
  }

  listarPendentes(companyId: string) {
    return this.repo.findPendingByCompany(companyId);
  }

  async revogar(companyId: string, inviteId: string, performedById: string): Promise<void> {
    const invite = await this.repo.findPendingById(companyId, inviteId);
    if (!invite) {
      throw new NotFoundException('Convite não encontrado');
    }

    await this.repo.revokeById(inviteId);
    this.logger.info({ companyId, inviteId, performedById }, 'Company invite revoked');
  }

  /**
   * Dados mínimos para a tela de aceite: nome da empresa e o e-mail que o convite
   * já contém. Quem tem o token já teria essa informação pelo e-mail recebido.
   */
  async preview(rawToken: string): Promise<ConvitePreview> {
    const invite = await this.repo.findByTokenHash(this.hash(rawToken));

    if (!invite || invite.company.deletedAt !== null || !invite.company.isActive) {
      return { status: 'not_found', companyName: null, email: null };
    }

    const base = { companyName: invite.company.legalName, email: invite.email };

    if (invite.revokedAt !== null) return { ...base, status: 'revoked' };
    if (invite.acceptedAt !== null) return { ...base, status: 'accepted' };
    if (invite.expiresAt < new Date()) return { ...base, status: 'expired' };

    return { ...base, status: 'valid' };
  }

  /**
   * Aceite do convite pelo usuário autenticado. O convite é vinculado ao e-mail:
   * repassar o link não dá acesso a terceiro, porque só quem está logado com aquele
   * endereço passa da validação.
   */
  async aceitar(
    rawToken: string,
    user: { id: string; email: string },
  ): Promise<{ companyId: string; companyName: string }> {
    const invite = await this.repo.findByTokenHash(this.hash(rawToken));

    if (!invite || invite.company.deletedAt !== null || !invite.company.isActive) {
      throw new BadRequestException('Convite inválido');
    }
    if (invite.revokedAt !== null) {
      throw new BadRequestException('Este convite foi cancelado. Peça um novo ao administrador.');
    }
    if (invite.acceptedAt !== null) {
      throw new BadRequestException('Este convite já foi utilizado.');
    }
    if (invite.expiresAt < new Date()) {
      throw new BadRequestException('Este convite expirou. Peça um novo ao administrador.');
    }

    if (ConviteService.normalizeEmail(user.email) !== invite.email) {
      this.logger.warn(
        { inviteId: invite.id, userId: user.id, companyId: invite.companyId },
        'Invite accept attempted with a different email',
      );
      throw new ForbiddenException(`Este convite é para ${invite.email}.`);
    }

    // O `BillingGateGuard` não resolve escopo nesta rota (não há `:companyId` no
    // caminho), então a checagem de empresa bloqueada é explícita aqui.
    const summary = await this.billingAccess.getSummary(invite.companyId);
    if (summary.mode === 'suspended') {
      throw new ForbiddenException('Esta empresa está com o acesso suspenso.');
    }

    // Checagem definitiva de assento: o admin pode ter enchido os assentos entre o
    // convite e o clique.
    await this.billingService.assertSeatAvailable(invite.companyId);

    const accepted = await this.repo.accept({
      inviteId: invite.id,
      companyId: invite.companyId,
      userId: user.id,
      role: invite.role,
    });

    if (!accepted) {
      throw new BadRequestException('Este convite já foi utilizado.');
    }

    this.logger.info(
      { inviteId: invite.id, userId: user.id, companyId: invite.companyId },
      'Company invite accepted',
    );

    return { companyId: invite.companyId, companyName: invite.company.legalName };
  }
}
