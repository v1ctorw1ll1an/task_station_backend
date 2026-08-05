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

  /**
   * Resposta ao auto-cadastro de colaborador quando o e-mail JÁ tem conta. O
   * endpoint responde `{ ok: true }` nos dois casos para não virar oráculo de
   * enumeração — quem realmente é dono da caixa descobre a situação por aqui.
   */
  async sendAccountAlreadyExistsEmail(to: string): Promise<void> {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const loginUrl = `${frontendUrl}/login`;
    const forgotUrl = `${frontendUrl}/forgot-password`;

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Você já tem conta no TaskDY',
      html: `
        <p>Recebemos um cadastro com este e-mail, mas você <strong>já tem uma conta</strong> no TaskDY.</p>
        <p><a href="${loginUrl}">Entrar no TaskDY</a></p>
        <p>Esqueceu a senha? <a href="${forgotUrl}">Recupere aqui</a>.</p>
        <p>Se não foi você quem tentou se cadastrar, pode ignorar este email — nada mudou na sua conta.</p>
      `,
      text: `Recebemos um cadastro com este e-mail, mas você já tem uma conta no TaskDY.\n\nEntrar: ${loginUrl}\nEsqueceu a senha: ${forgotUrl}\n\nSe não foi você, pode ignorar este email — nada mudou na sua conta.`,
    });

    if (error) {
      this.logger.error(
        { to, errorCode: error.name, errorMessage: error.message },
        'Failed to send account-already-exists email',
      );
      throw new InternalServerErrorException('Erro ao enviar email');
    }

    this.logger.info({ to }, 'Account-already-exists email sent via Resend');
  }

  /**
   * Convite para entrar numa empresa existente. Vai para quem JÁ tem conta no
   * TaskDY — quem não tem recebe o magic link de primeiro acesso e já entra
   * vinculado (ver `EmpresaService.contratarMembro`).
   */
  async sendCompanyInviteEmail(
    to: string,
    companyName: string,
    inviteUrl: string,
    expiresInDays: number,
  ): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: `Convite para entrar em ${companyName} — TaskDY`,
      html: `
        <p>Você foi convidado para entrar na empresa <strong>${companyName}</strong> no TaskDY.</p>
        <p><a href="${inviteUrl}">Aceitar convite</a></p>
        <p>O convite expira em <strong>${expiresInDays} dia(s)</strong> e só pode ser aceito com esta conta de e-mail.</p>
        <p>Se você não esperava este convite, ignore este email.</p>
      `,
      text: `Você foi convidado para entrar na empresa ${companyName} no TaskDY.\n\nAceitar convite (expira em ${expiresInDays} dia(s), só vale para este e-mail):\n${inviteUrl}\n\nSe você não esperava este convite, ignore este email.`,
    });

    if (error) {
      this.logger.error(
        { to, companyName, errorCode: error.name, errorMessage: error.message },
        'Failed to send company invite email',
      );
      throw new InternalServerErrorException('Erro ao enviar email de convite');
    }

    this.logger.info({ to, companyName }, 'Company invite email sent via Resend');
  }

  // ── Cobrança (não-lançantes: cron/webhook não podem quebrar por email) ──────

  private billingUrl(companyId: string): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    return `${frontendUrl}/empresa/${companyId}/cobranca`;
  }

  private async sendBilling(
    to: string[],
    subject: string,
    bodyHtml: string,
    bodyText: string,
  ): Promise<void> {
    if (to.length === 0) return;
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html: bodyHtml,
      text: bodyText,
    });
    if (error) {
      this.logger.error({ to, subject, errorCode: error.name }, 'Failed to send billing email');
      return; // não-lançante
    }
    this.logger.info({ to, subject }, 'Billing email sent via Resend');
  }

  async sendTrialEndingEmail(to: string[], companyId: string, daysLeft: number): Promise<void> {
    const url = this.billingUrl(companyId);
    await this.sendBilling(
      to,
      `Seu teste do TaskDY termina em ${daysLeft} dia(s)`,
      `<p>O período de teste da sua empresa termina em <strong>${daysLeft} dia(s)</strong>.</p>
       <p>Escolha um plano para não perder o acesso.</p>
       <p><a href="${url}">Assinar agora</a></p>`,
      `Seu teste do TaskDY termina em ${daysLeft} dia(s). Assine em: ${url}`,
    );
  }

  async sendTrialEndedEmail(to: string[], companyId: string): Promise<void> {
    const url = this.billingUrl(companyId);
    await this.sendBilling(
      to,
      'Seu teste do TaskDY terminou',
      `<p>O período de teste terminou e o acesso da empresa foi <strong>bloqueado</strong>.</p>
       <p>Assine um plano para voltar a usar o TaskDY. Seus dados estão preservados.</p>
       <p><a href="${url}">Assinar agora</a></p>`,
      `O teste terminou e o acesso foi bloqueado. Assine em: ${url}`,
    );
  }

  async sendPaymentConfirmedEmail(
    to: string[],
    companyId: string,
    amountLabel: string,
  ): Promise<void> {
    const url = this.billingUrl(companyId);
    await this.sendBilling(
      to,
      'Pagamento confirmado — TaskDY',
      `<p>Recebemos seu pagamento de <strong>${amountLabel}</strong>. A assinatura está ativa.</p>
       <p><a href="${url}">Ver cobrança</a></p>`,
      `Recebemos seu pagamento de ${amountLabel}. A assinatura está ativa. ${url}`,
    );
  }

  async sendPaymentFailedEmail(
    to: string[],
    companyId: string,
    graceUntil: Date,
    invoiceUrl?: string | null,
  ): Promise<void> {
    const url = this.billingUrl(companyId);
    const grace = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'long',
      timeZone: 'America/Sao_Paulo',
    }).format(graceUntil);
    await this.sendBilling(
      to,
      'Falha no pagamento — regularize para não perder o acesso',
      `<p>Não conseguimos renovar sua assinatura. Você tem até <strong>${grace}</strong> antes de a empresa ser bloqueada.</p>
       ${invoiceUrl ? `<p><a href="${invoiceUrl}">Pagar a fatura</a></p>` : ''}
       <p><a href="${url}">Ver cobrança</a></p>`,
      `Falha no pagamento. Regularize até ${grace}. ${invoiceUrl ?? url}`,
    );
  }

  async sendReadOnlyActivatedEmail(to: string[], companyId: string): Promise<void> {
    const url = this.billingUrl(companyId);
    await this.sendBilling(
      to,
      'O acesso da sua empresa foi bloqueado',
      `<p>A empresa foi <strong>bloqueada</strong> por falta de pagamento. Os dados estão preservados.</p>
       <p>Regularize a cobrança para reativar o acesso.</p>
       <p><a href="${url}">Regularizar</a></p>`,
      `A empresa foi bloqueada. Regularize em: ${url}`,
    );
  }

  async sendAnnualRenewalReminderEmail(
    to: string[],
    companyId: string,
    daysLeft: number,
  ): Promise<void> {
    const url = this.billingUrl(companyId);
    await this.sendBilling(
      to,
      `Sua assinatura anual do TaskDY vence em ${daysLeft} dia(s)`,
      `<p>Sua assinatura anual vence em <strong>${daysLeft} dia(s)</strong>. Renove para manter o acesso.</p>
       <p><a href="${url}">Renovar</a></p>`,
      `Sua assinatura anual vence em ${daysLeft} dia(s). Renove em: ${url}`,
    );
  }

  /**
   * Aviso de que os dados da empresa cancelada serão excluídos (R43). É o último
   * contato antes de algo irreversível — precisa dizer o prazo e as duas saídas:
   * voltar a assinar ou exportar.
   */
  async sendDataRetentionWarningEmail(
    to: string[],
    companyId: string,
    diasRestantes: number,
  ): Promise<void> {
    const url = this.billingUrl(companyId);
    await this.sendBilling(
      to,
      `Seus dados no TaskDY serão excluídos em ${diasRestantes} dia(s)`,
      `<p>A assinatura desta empresa foi cancelada e, em <strong>${diasRestantes} dia(s)</strong>,
        os quadros, tarefas e anexos serão <strong>excluídos definitivamente</strong>.</p>
       <p>Para manter tudo, assine um plano novamente. Se preferir só guardar uma cópia,
        exporte os dados antes do prazo.</p>
       <p><a href="${url}">Assinar de novo ou exportar</a></p>`,
      `Seus dados no TaskDY serão excluídos em ${diasRestantes} dia(s). Assine de novo ou exporte em: ${url}`,
    );
  }

  /**
   * Alerta operacional **interno** de cobrança (fila de webhook parada, pagamento
   * sem cobrança correspondente, estorno). Destino: `BILLING_ALERT_EMAIL` (lista
   * separada por vírgula); sem a env configurada não envia — a métrica e o log
   * continuam valendo.
   */
  async sendBillingOpsAlert(subject: string, details: Record<string, unknown>): Promise<void> {
    const raw = this.configService.get<string>('BILLING_ALERT_EMAIL') ?? '';
    const to = raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    if (to.length === 0) return;

    const entries = Object.entries(details);
    await this.sendBilling(
      to,
      `[TaskDY · cobrança] ${subject}`,
      `<p><strong>${subject}</strong></p>
       <ul>${entries.map(([k, v]) => `<li><strong>${k}:</strong> ${String(v)}</li>`).join('')}</ul>`,
      `${subject}\n${entries.map(([k, v]) => `${k}: ${String(v)}`).join('\n')}`,
    );
  }

  async sendSeatPixEmail(
    to: string[],
    companyId: string,
    qrPayload: string,
    expiresAt: Date,
  ): Promise<void> {
    const url = this.billingUrl(companyId);
    const exp = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Sao_Paulo',
    }).format(expiresAt);
    await this.sendBilling(
      to,
      'Pix gerado para os novos usuários',
      `<p>Geramos um Pix para os usuários adicionais. Ele expira em <strong>${exp}</strong>.</p>
       <p>Copia e cola:</p><p style="font-family:monospace;word-break:break-all">${qrPayload}</p>
       <p><a href="${url}">Ver cobrança</a></p>`,
      `Pix gerado para os novos usuários (expira ${exp}).\nCopia e cola: ${qrPayload}\n${url}`,
    );
  }
}
