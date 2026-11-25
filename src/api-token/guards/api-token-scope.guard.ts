import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiTokenContext } from '../api-token.constants';
import { ALLOW_API_TOKEN_KEY } from '../decorators/allow-api-token.decorator';

interface ScopedRequest {
  method: string;
  url?: string;
  apiToken?: ApiTokenContext;
  params?: { companyId?: string; workspaceId?: string; projectId?: string };
}

/**
 * O que um token de acesso pessoal (PAT) pode fazer. Roda logo após o `JwtAuthGuard`
 * (global). Request de navegador (JWT) passa direto: nada muda para ela.
 *
 * Para PAT, duas travas, ambas no servidor — o cliente MCP não é barreira:
 * 1. **Rota**: só handlers com `@AllowApiToken()`. Rota nova nasce bloqueada.
 * 2. **Workspace**: o escopo da rota (`:workspaceId` direto, ou o workspace do
 *    `:projectId`) tem que ser o do token. Rota de empresa (`:companyId`) é recusada.
 *
 * O workspace do projeto é lido a cada request, sem cache: projeto pode ser movido de
 * workspace (`PATCH workspace/:id/projetos/:projectId/mover`). Task e coluna não
 * precisam de checagem própria: os services sempre buscam por `(id, projectId)`.
 */
@Injectable()
export class ApiTokenScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(ApiTokenScopeGuard.name)
    private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<ScopedRequest>();
    const token = req.apiToken;
    if (!token) return true;

    const allowed = this.reflector.get<boolean>(ALLOW_API_TOKEN_KEY, context.getHandler());
    if (allowed !== true) {
      this.logger.warn(
        { apiTokenId: token.id, method: req.method, url: req.url },
        'API token used on a route it is not allowed on',
      );
      throw new ForbiddenException({
        code: 'API_TOKEN_ROUTE_NOT_ALLOWED',
        message: 'Esta operação não está disponível para tokens de acesso',
      });
    }

    const { companyId, workspaceId, projectId } = req.params ?? {};
    const outOfScope = () => {
      this.logger.warn(
        { apiTokenId: token.id, workspaceId: token.workspaceId, method: req.method, url: req.url },
        'API token used outside its workspace',
      );
      return new ForbiddenException({
        code: 'API_TOKEN_OUT_OF_SCOPE',
        message: 'Este token só dá acesso ao workspace para o qual foi criado',
      });
    };

    if (companyId) throw outOfScope();
    if (workspaceId && workspaceId !== token.workspaceId) throw outOfScope();

    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId },
        select: { workspaceId: true },
      });
      // Projeto inexistente e projeto de outro workspace dão a mesma resposta: o
      // token não descobre o que existe fora do escopo dele.
      if (!project || project.workspaceId !== token.workspaceId) throw outOfScope();
    }

    return true;
  }
}
