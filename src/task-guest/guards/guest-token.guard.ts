import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { TaskGuestRepository } from '../task-guest.repository';

export interface GuestContext {
  guestId: string;
  taskId: string;
  projectId: string;
}

interface GuestRequest {
  params: { token?: string };
  guestContext?: GuestContext;
}

@Injectable()
export class GuestTokenGuard implements CanActivate {
  constructor(
    private readonly repo: TaskGuestRepository,
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

    request.guestContext = {
      guestId: guest.id,
      taskId: guest.taskId,
      projectId: guest.task.projectId,
    };

    await this.repo.touchLastAccessed(guest.id);
    return true;
  }
}
