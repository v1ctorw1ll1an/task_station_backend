import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { BillingAccessService } from '../../billing/billing-access.service';
import { TaskGuestRepository } from '../task-guest.repository';

export interface GuestContext {
  guestId: string;
  taskId: string;
  projectId: string;
  companyId: string;
}

/** Mesmo conjunto do `BillingGateGuard` — a regra é uma só no sistema. */
const LEITURA_OU_EXCLUSAO = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

interface GuestRequest {
  method: string;
  params: { token?: string };
  guestContext?: GuestContext;
}

@Injectable()
export class GuestTokenGuard implements CanActivate {
  constructor(
    private readonly repo: TaskGuestRepository,
    private readonly access: BillingAccessService,
    @InjectPinoLogger(GuestTokenGuard.name)
    private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuestRequest>();
    const rawToken = request.params?.token;
    if (!rawToken) {
      throw new NotFoundException('Link inválido');
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const guest = await this.repo.findActiveGuestByTokenHash(tokenHash);

    if (!guest || guest.task.deletedAt !== null || guest.task.project.deletedAt !== null) {
      this.logger.warn(
        { tokenHashPrefix: tokenHash.slice(0, 8) },
        'Tentativa de acesso com token inválido ou recurso indisponível',
      );
      throw new NotFoundException('Link inválido');
    }

    if (guest.expiresAt && guest.expiresAt.getTime() < Date.now()) {
      this.logger.warn(
        { tokenHashPrefix: tokenHash.slice(0, 8), guestId: guest.id },
        'Tentativa de acesso com token expirado',
      );
      throw new NotFoundException('Link expirado');
    }

    if (!guest.linkEnabled) {
      this.logger.warn(
        { tokenHashPrefix: tokenHash.slice(0, 8), guestId: guest.id },
        'Tentativa de acesso com link desabilitado',
      );
      throw new NotFoundException('Link desabilitado');
    }

    const companyId = guest.task.project.workspace.companyId;

    // Mesma regra do time (R20): em somente-leitura o convidado consulta e apaga,
    // mas não cria nem edita. Empresa suspensa não abre nem o link.
    const mode = await this.access.getMode(companyId);
    const permitido =
      mode === 'ok' || (mode === 'read_only' && LEITURA_OU_EXCLUSAO.has(request.method));
    if (!permitido) {
      throw new ForbiddenException({
        code: 'COMPANY_BLOCKED',
        message:
          mode === 'suspended'
            ? 'Este link está indisponível no momento.'
            : 'Edição indisponível: a cobrança da empresa está pendente.',
      });
    }

    request.guestContext = {
      guestId: guest.id,
      taskId: guest.taskId,
      projectId: guest.task.projectId,
      companyId,
    };

    await this.repo.touchLastAccessed(guest.id);
    return true;
  }
}
