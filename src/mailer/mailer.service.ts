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
    this.from = this.configService.get<string>(
      'MAILER_FROM',
      'TaskDY <noreply@contato.taskstation.manyflux.com.br>',
    );
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Redefinição de senha — TaskDY',
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
      subject: 'Bem-vindo ao TaskDY — Suas credenciais de acesso',
      html: `
        <p>Olá, <strong>${name}</strong>!</p>
        <p>Sua conta no <strong>TaskDY</strong> foi criada. Utilize as credenciais abaixo para o primeiro acesso:</p>
        <ul>
          <li><strong>Email:</strong> ${to}</li>
          <li><strong>Senha temporária:</strong> ${tempPassword}</li>
        </ul>
        <p>Você será solicitado a criar uma nova senha ao fazer login.</p>
        <p><a href="${frontendUrl}/login">Acessar o TaskDY</a></p>
        <p>Se você não esperava este email, entre em contato com o administrador.</p>
      `,
      text: `Olá, ${name}!\n\nSua conta no TaskDY foi criada.\n\nEmail: ${to}\nSenha temporária: ${tempPassword}\n\nVocê será solicitado a criar uma nova senha ao fazer login.\n\nAcesse: ${frontendUrl}/login`,
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

  async sendEventNotificationEmail(params: {
    to: string;
    kind: 'created' | 'updated' | 'cancelled';
    title: string;
    startsAt: Date;
    endsAt: Date;
    location: string | null;
    description: string | null;
    timezone: string;
    organizerName?: string | null;
  }): Promise<void> {
    const { to, kind, title, startsAt, endsAt, location, description, timezone, organizerName } =
      params;

    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(d);

    const verb =
      kind === 'created'
        ? 'Novo evento'
        : kind === 'updated'
          ? 'Evento atualizado'
          : 'Evento cancelado';
    const subject = `${verb}: ${title}`;
    const intro =
      kind === 'created'
        ? `Você foi convidado para um novo evento: <strong>${title}</strong>.`
        : kind === 'updated'
          ? `O evento <strong>${title}</strong> foi atualizado.`
          : `O evento <strong>${title}</strong> foi cancelado.`;

    const html = `
      <p>${intro}</p>
      ${
        kind !== 'cancelled'
          ? `
        <p><strong>Início:</strong> ${fmt(startsAt)}<br/>
           <strong>Fim:</strong> ${fmt(endsAt)}</p>
        ${location ? `<p><strong>Local:</strong> ${location}</p>` : ''}
        ${description ? `<p>${description.replace(/\n/g, '<br/>')}</p>` : ''}
      `
          : ''
      }
      ${organizerName ? `<p style="color:#666;font-size:12px">Organizador: ${organizerName}</p>` : ''}
    `;

    const text =
      `${verb}: ${title}\n\n` +
      (kind !== 'cancelled'
        ? `Início: ${fmt(startsAt)}\nFim: ${fmt(endsAt)}\n` +
          (location ? `Local: ${location}\n` : '') +
          (description ? `\n${description}\n` : '')
        : '') +
      (organizerName ? `\nOrganizador: ${organizerName}\n` : '');

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
      text,
    });

    if (error) {
      this.logger.error(
        { to, kind, errorCode: error.name, errorMessage: error.message },
        'Failed to send event notification email',
      );
      // Não throwa — notificações não devem quebrar a mutação principal
      return;
    }

    this.logger.info({ to, kind, title }, 'Event notification email sent via Resend');
  }

  async sendEventReminderEmail(params: {
    to: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    location: string | null;
    description: string | null;
    minutesBefore: number;
    timezone: string;
  }): Promise<void> {
    const { to, title, startsAt, endsAt, location, description, minutesBefore, timezone } = params;

    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(d);

    const minutesLabel =
      minutesBefore >= 1440
        ? `${Math.round(minutesBefore / 1440)} dia(s)`
        : minutesBefore >= 60
          ? `${Math.round(minutesBefore / 60)} hora(s)`
          : `${minutesBefore} minutos`;

    const subject = `Lembrete: ${title} (em ${minutesLabel})`;

    const html = `
      <p>Olá!</p>
      <p>Este é um lembrete do seu evento <strong>${title}</strong>, que começa em <strong>${minutesLabel}</strong>.</p>
      <p><strong>Início:</strong> ${fmt(startsAt)}<br/>
         <strong>Fim:</strong> ${fmt(endsAt)}</p>
      ${location ? `<p><strong>Local:</strong> ${location}</p>` : ''}
      ${description ? `<p>${description.replace(/\n/g, '<br/>')}</p>` : ''}
    `;

    const text =
      `Lembrete: ${title} (em ${minutesLabel})\n\n` +
      `Início: ${fmt(startsAt)}\nFim: ${fmt(endsAt)}\n` +
      (location ? `Local: ${location}\n` : '') +
      (description ? `\n${description}\n` : '');

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
      text,
    });

    if (error) {
      this.logger.error(
        { to, errorCode: error.name, errorMessage: error.message },
        'Failed to send event reminder email',
      );
      throw new InternalServerErrorException('Erro ao enviar lembrete');
    }

    this.logger.info({ to, title, minutesBefore }, 'Event reminder email sent via Resend');
  }

  async sendFirstAccessEmail(to: string, name: string, magicLink: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Bem-vindo ao TaskDY — Acesse sua conta',
      html: `
        <p>Olá, <strong>${name}</strong>!</p>
        <p>Sua conta no <strong>TaskDY</strong> foi criada. Clique no link abaixo para definir sua senha e acessar o sistema.</p>
        <p><a href="${magicLink}">Acessar o TaskDY</a></p>
        <p>O link expira em <strong>7 dias</strong>. Se você não esperava este email, entre em contato com o administrador.</p>
      `,
      text: `Olá, ${name}!\n\nSua conta no TaskDY foi criada.\n\nClique no link abaixo para definir sua senha (expira em 7 dias):\n${magicLink}\n\nSe você não esperava este email, entre em contato com o administrador.`,
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
