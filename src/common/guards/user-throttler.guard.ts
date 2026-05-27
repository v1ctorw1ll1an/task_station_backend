import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

interface ThrottleRequest {
  ip?: string;
  ips?: string[];
  user?: { sub?: string; id?: string };
}

/**
 * Identifica a cota por userId quando autenticado, caindo para o IP quando não há
 * usuário. Evita que múltiplos usuários atrás de um mesmo NAT compartilhem o
 * orçamento de requisições.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as ThrottleRequest;
    const userId = r.user?.sub ?? r.user?.id;
    const ip = r.ip ?? r.ips?.[0] ?? 'unknown';
    return Promise.resolve(userId ? `user:${userId}` : `ip:${ip}`);
  }
}
