import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Resend } from 'resend';

@Injectable()
export class MailerService {
  private readonly resend: Resend;
  private readonly from: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectPinoLogger(MailerService.name)
    private readonly logger: PinoLogger,
  ) {
    const apiKey = this.configService.getOrThrow<string>('RESEND_API_KEY');
    this.resend = new Resend(apiKey);
    this.from = this.configService.getOrThrow<string>('MAILER_FROM');
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Redefinição de senha — Task Station',
      html: `
        <p>Você solicitou a redefinição da sua senha.</p>
        <p>Clique no link abaixo para criar uma nova senha. O link expira em <strong>1 hora</strong>.</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>Se você não solicitou isso, ignore este email.</p>
      `,
      text: `Você solicitou a redefinição da sua senha.\n\nAcesse o link abaixo para criar uma nova senha (expira em 1 hora):\n${resetUrl}\n\nSe você não solicitou isso, ignore este email.`,
    });

    if (error) {
      this.logger.error(
        { to, errorCode: error.name, errorMessage: error.message },
        'Failed to send password reset email',
      );
      throw new InternalServerErrorException('Erro ao enviar email');
    }

    this.logger.info({ to }, 'Password reset email sent via Resend');
  }

  async sendWelcomeEmail(to: string, name: string, tempPassword: string): Promise<void> {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Bem-vindo ao Task Station — Suas credenciais de acesso',
      html: `
        <p>Olá, <strong>${name}</strong>!</p>
        <p>Sua conta no <strong>Task Station</strong> foi criada. Utilize as credenciais abaixo para o primeiro acesso:</p>
        <ul>
          <li><strong>Email:</strong> ${to}</li>
          <li><strong>Senha temporária:</strong> ${tempPassword}</li>
        </ul>
        <p>Você será solicitado a criar uma nova senha ao fazer login.</p>
        <p><a href="${frontendUrl}/login">Acessar o Task Station</a></p>
        <p>Se você não esperava este email, entre em contato com o administrador.</p>
      `,
      text: `Olá, ${name}!\n\nSua conta no Task Station foi criada.\n\nEmail: ${to}\nSenha temporária: ${tempPassword}\n\nVocê será solicitado a criar uma nova senha ao fazer login.\n\nAcesse: ${frontendUrl}/login`,
    });

    if (error) {
      this.logger.error(
        { to, errorCode: error.name, errorMessage: error.message },
        'Failed to send welcome email',
      );
      throw new InternalServerErrorException('Erro ao enviar email de boas-vindas');
    }

    this.logger.info({ to }, 'Welcome email sent via Resend');
  }

  async sendFirstAccessEmail(to: string, name: string, magicLink: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Bem-vindo ao Task Station — Acesse sua conta',
      html: `
        <p>Olá, <strong>${name}</strong>!</p>
        <p>Sua conta no <strong>Task Station</strong> foi criada. Clique no link abaixo para definir sua senha e acessar o sistema.</p>
        <p><a href="${magicLink}">Acessar o Task Station</a></p>
        <p>O link expira em <strong>7 dias</strong>. Se você não esperava este email, entre em contato com o administrador.</p>
      `,
      text: `Olá, ${name}!\n\nSua conta no Task Station foi criada.\n\nClique no link abaixo para definir sua senha (expira em 7 dias):\n${magicLink}\n\nSe você não esperava este email, entre em contato com o administrador.`,
    });

    if (error) {
      this.logger.error(
        { to, errorCode: error.name, errorMessage: error.message },
        'Failed to send first access email',
      );
      throw new InternalServerErrorException('Erro ao enviar email de primeiro acesso');
    }

    this.logger.info({ to }, 'First access email sent via Resend');
  }
}
