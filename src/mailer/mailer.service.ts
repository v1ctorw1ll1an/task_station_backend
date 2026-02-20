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
}
