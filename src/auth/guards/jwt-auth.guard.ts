import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { API_TOKEN_PREFIX, ApiTokenContext } from '../../api-token/api-token.constants';
import { ApiTokenService } from '../../api-token/api-token.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthUser } from '../strategies/jwt.strategy';

interface AuthRequest {
  headers?: Record<string, string | string[] | undefined>;
  user?: AuthUser;
  apiToken?: ApiTokenContext;
}

const BEARER_API_TOKEN = new RegExp(`^Bearer\\s+(${API_TOKEN_PREFIX}\\S+)$`, 'i');

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiTokens: ApiTokenService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Token de acesso pessoal (`tdy_…`): autentica como o usuário sem passar pela
    // sessão — não é login, não ocupa o assento. O que ele pode fazer é decidido
    // depois, no `ApiTokenScopeGuard`.
    const apiToken = this.extractApiToken(context);
    if (apiToken) {
      return this.authenticateApiToken(context, apiToken);
    }

    return super.canActivate(context);
  }

  private extractApiToken(context: ExecutionContext): string | null {
    if (context.getType() !== 'http') return null;
    const header = context.switchToHttp().getRequest<AuthRequest>().headers?.authorization;
    if (typeof header !== 'string') return null;
    return BEARER_API_TOKEN.exec(header)?.[1] ?? null;
  }

  private async authenticateApiToken(context: ExecutionContext, raw: string): Promise<boolean> {
    const { user, token } = await this.apiTokens.authenticate(raw);
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.user = user;
    request.apiToken = token;
    return true;
  }
}
