import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { API_TOKEN } from '../common/limits';
import {
  API_TOKEN_DISPLAY_LENGTH,
  API_TOKEN_LAST_USED_RESOLUTION_MS,
  API_TOKEN_MAX_LENGTH,
  API_TOKEN_PREFIX,
  ApiTokenContext,
} from './api-token.constants';
import { ApiTokenRepository, ApiTokenView } from './api-token.repository';
import { CreateApiTokenDto } from './dto/create-api-token.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ApiTokenAuthentication {
  user: AuthUser;
  token: ApiTokenContext;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

type TokenRecord = Awaited<ReturnType<ApiTokenRepository['findByHash']>>;

/** Por que o token não vale — só para o log; o cliente recebe sempre a mesma resposta. */
function rejectionReason(record: TokenRecord, now: Date): string | null {
  if (!record) return 'unknown';
  if (record.revokedAt) return 'revoked';
  if (record.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (record.user.deletedAt || !record.user.isActive) return 'user_inactive';
  // A integração com o Claude Code é só de superusuário. Rebaixado, o token para na
  // hora — mesmo que a revogação no rebaixamento tenha falhado ou sido pulada.
  if (!record.user.isSuperuser) return 'owner_not_superuser';
  if (record.workspace.deletedAt || !record.workspace.isActive) return 'workspace_inactive';
  // Empresa excluída/desativada pelo superusuário: o front esconde, mas o cliente MCP
  // não tem front — sem esta trava o token seguiria lendo e escrevendo.
  if (record.workspace.company.deletedAt || !record.workspace.company.isActive) {
    return 'company_inactive';
  }
  return null;
}

/**
 * Tokens de acesso pessoal (PAT): um cliente externo — o servidor MCP do Claude Code —
 * age como o usuário, num único workspace, sem ocupar o assento de login.
 *
 * **Só superusuário** cria, lista e revoga (`SuperuserGuard` no controller), e o token só
 * vale enquanto o dono for superusuário. Para os demais o token seria uma porta para
 * compartilhar a conta sem ocupar assento.
 *
 * Quem decide **o que** o token pode fazer é o `ApiTokenScopeGuard` (lista fechada de
 * rotas + workspace). Aqui fica só o ciclo de vida: criar, listar, revogar, validar.
 */
@Injectable()
export class ApiTokenService {
  constructor(
    private readonly repo: ApiTokenRepository,
    @InjectPinoLogger(ApiTokenService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** Devolve o token em claro — a **única** vez que ele existe fora do cliente. */
  async create(userId: string, dto: CreateApiTokenDto): Promise<ApiTokenView & { token: string }> {
    const workspace = await this.repo.findActiveWorkspace(dto.workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }
    const hasAccess = await this.repo.hasWorkspaceAccess(userId, workspace.id, workspace.companyId);
    if (!hasAccess) {
      throw new ForbiddenException('Você não é membro deste workspace');
    }

    const now = new Date();
    const raw = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(raw);
    const days = dto.expiresInDays ?? API_TOKEN.defaultDays;

    const created = await this.repo.createWithinLimit(
      {
        userId,
        workspaceId: workspace.id,
        name: dto.name.trim(),
        tokenHash,
        prefix: raw.slice(0, API_TOKEN_DISPLAY_LENGTH),
        expiresAt: new Date(now.getTime() + days * DAY_MS),
      },
      API_TOKEN.maxActivePerUser,
      now,
    );
    if (!created) {
      throw new BadRequestException(
        `Limite de ${API_TOKEN.maxActivePerUser} tokens ativos atingido. Revogue um antes de criar outro.`,
      );
    }

    this.logger.info(
      {
        userId,
        workspaceId: workspace.id,
        apiTokenId: created.id,
        tokenHashPrefix: tokenHash.slice(0, 8),
        days,
      },
      'API token created',
    );
    return { ...created, token: raw };
  }

  list(userId: string): Promise<ApiTokenView[]> {
    return this.repo.listByUser(userId);
  }

  /** Para o seletor da tela: onde dá para criar token (mesma regra do `create`). */
  async listEligibleWorkspaces(userId: string) {
    const workspaces = await this.repo.findEligibleWorkspaces(userId);
    return workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      companyId: w.company.id,
      companyName: w.company.legalName,
    }));
  }

  async revoke(userId: string, id: string): Promise<void> {
    const { count } = await this.repo.revoke(userId, id, new Date());
    if (count === 0) {
      throw new NotFoundException('Token não encontrado');
    }
    this.logger.info({ userId, apiTokenId: id }, 'API token revoked');
  }

  /**
   * Valida o PAT e devolve o usuário no **mesmo formato** do `JwtStrategy`, para que os
   * guards de recurso (membro do projeto, cobrança, throttle) funcionem sem mudança.
   *
   * Não toca `activeSessionId`: o token não é um login, não derruba o navegador.
   * Usuário desativado/excluído perde acesso na hora, como no JWT.
   */
  async authenticate(raw: string): Promise<ApiTokenAuthentication> {
    const invalid = () =>
      new UnauthorizedException({
        code: 'API_TOKEN_INVALID',
        message: 'Token de acesso inválido, expirado ou revogado',
      });

    if (!raw.startsWith(API_TOKEN_PREFIX) || raw.length > API_TOKEN_MAX_LENGTH) {
      throw invalid();
    }

    const tokenHash = hashToken(raw);
    const record = await this.repo.findByHash(tokenHash);
    const now = new Date();
    const motivo = rejectionReason(record, now);

    if (!record || motivo) {
      this.logger.warn(
        { tokenHashPrefix: tokenHash.slice(0, 8), apiTokenId: record?.id, motivo },
        'API token rejected',
      );
      throw invalid();
    }

    const lastUsed = record.lastUsedAt?.getTime() ?? 0;
    if (now.getTime() - lastUsed > API_TOKEN_LAST_USED_RESOLUTION_MS) {
      // Fora do caminho da request: auditoria não pode atrasar nem derrubar a chamada.
      void this.repo.touchLastUsed(record.id, now).catch((err: unknown) => {
        this.logger.warn(
          { apiTokenId: record.id, err: (err as Error).message },
          'Failed to update API token lastUsedAt',
        );
      });
    }

    return {
      user: {
        id: record.user.id,
        email: record.user.email,
        // Token nunca carrega poder de superusuário, mesmo que o dono tenha: o PAT é
        // para mexer em tasks de um workspace, não para administrar o sistema.
        isSuperuser: false,
        mustResetPassword: record.user.mustResetPassword,
      },
      token: { id: record.id, workspaceId: record.workspaceId },
    };
  }

  /**
   * Usado pelo cliente MCP na partida para descobrir a que workspace pertence.
   * Confere o vínculo de novo: quem saiu do workspace não vê nem o nome dele.
   */
  async describeCurrent(token: ApiTokenContext, user: AuthUser) {
    const current = await this.repo.findCurrent(token.id);
    if (!current) {
      throw new NotFoundException('Token não encontrado');
    }
    const hasAccess = await this.repo.hasWorkspaceAccess(
      user.id,
      current.workspace.id,
      current.workspace.companyId,
    );
    if (!hasAccess) {
      throw new ForbiddenException({
        code: 'API_TOKEN_OUT_OF_SCOPE',
        message: 'Você não é mais membro do workspace deste token',
      });
    }

    return {
      tokenId: current.id,
      name: current.name,
      expiresAt: current.expiresAt,
      user: current.user,
      workspace: {
        id: current.workspace.id,
        name: current.workspace.name,
        companyId: current.workspace.companyId,
        companyName: current.workspace.company.legalName,
      },
    };
  }
}
