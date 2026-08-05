import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import type { AuthUser } from '../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingAccessService } from '../billing-access.service';
import { SKIP_BILLING_GATE_KEY } from '../decorators/skip-billing-gate.decorator';

interface ScopedRequest {
  method: string;
  user?: AuthUser;
  params: { companyId?: string; workspaceId?: string; projectId?: string };
}

/**
 * Verbos que a empresa em somente-leitura continua podendo usar. Apagar entra aqui
 * porque é o cliente mexendo no dado dele (limpeza, saída), não consumo do produto.
 * Atenção: a regra é pelo **verbo**; operação destrutiva feita via `PATCH` (arquivar,
 * por exemplo) segue bloqueada — e está certo, é alteração.
 */
const LEITURA_OU_EXCLUSAO = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

/**
 * Gate global de acesso por empresa — a **garantia** do modelo (o front sozinho é
 * contornável por API). Aplica a tabela de R20/R44:
 *
 * | verbo              | normal | somente-leitura | suspensa |
 * |--------------------|--------|-----------------|----------|
 * | GET/HEAD/OPTIONS   |   ✅   |       ✅        |    ❌    |
 * | DELETE             |   ✅   |       ✅        |    ❌    |
 * | POST/PUT/PATCH     |   ✅   |       ❌        |    ❌    |
 *
 * Libera sempre: rotas públicas, `@SkipBillingGate` (auth, cobrança, exportação),
 * superusuário e requests sem escopo de empresa resolvível — estes últimos estão
 * classificados um a um em `test/billing-gate-coverage.e2e-spec.ts`, que quebra o CI
 * se aparecer rota nova sem decisão. A resolução escopo→empresa é cacheada (imutável).
 */

@Injectable()
export class BillingGateGuard implements CanActivate {
  private readonly scopeCache = new Map<string, string>();

  constructor(
    private readonly reflector: Reflector,
    private readonly access: BillingAccessService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ScopedRequest>();

    const targets = [context.getHandler(), context.getClass()];
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_BILLING_GATE_KEY, targets);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    if (skip || isPublic) return true;

    const user = req.user;
    if (!user) return true; // rota pública sem usuário resolvido
    if (user.isSuperuser) return true;

    const companyId = await this.resolveCompanyId(req.params);
    if (!companyId) return true; // sem escopo de empresa → nada a bloquear

    const summary = await this.access.getSummary(companyId);
    if (summary.mode === 'ok') return true;

    // Somente-leitura (R20): a empresa continua **usando** o sistema — consulta e
    // apaga o que é dela. O que fica barrado é produzir: criar e alterar.
    if (summary.mode === 'read_only' && LEITURA_OU_EXCLUSAO.has(req.method)) return true;

    throw new ForbiddenException({
      code: 'COMPANY_BLOCKED',
      reason: summary.blockReason,
      message: BillingAccessService.mensagemDeBloqueio(summary.blockReason),
    });
  }

  private async resolveCompanyId(params: ScopedRequest['params']): Promise<string | null> {
    if (params.companyId) return params.companyId;

    if (params.workspaceId) {
      return this.resolveCached(`w:${params.workspaceId}`, async () => {
        const w = await this.prisma.workspace.findUnique({
          where: { id: params.workspaceId },
          select: { companyId: true },
        });
        return w?.companyId ?? null;
      });
    }

    if (params.projectId) {
      return this.resolveCached(`p:${params.projectId}`, async () => {
        const p = await this.prisma.project.findUnique({
          where: { id: params.projectId },
          select: { workspace: { select: { companyId: true } } },
        });
        return p?.workspace.companyId ?? null;
      });
    }

    return null;
  }

  private async resolveCached(
    key: string,
    loader: () => Promise<string | null>,
  ): Promise<string | null> {
    const cached = this.scopeCache.get(key);
    if (cached) return cached;
    const value = await loader();
    if (value) this.scopeCache.set(key, value);
    return value;
  }
}
