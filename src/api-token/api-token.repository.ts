import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** O que o usuário vê do token — nunca o hash. */
const VIEW_SELECT = {
  id: true,
  name: true,
  prefix: true,
  expiresAt: true,
  lastUsedAt: true,
  createdAt: true,
  workspace: {
    select: { id: true, name: true, company: { select: { id: true, legalName: true } } },
  },
} satisfies Prisma.ApiTokenSelect;

export type ApiTokenView = Prisma.ApiTokenGetPayload<{ select: typeof VIEW_SELECT }>;

export interface CreateApiTokenData {
  userId: string;
  workspaceId: string;
  name: string;
  tokenHash: string;
  prefix: string;
  expiresAt: Date;
}

@Injectable()
export class ApiTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Workspace e empresa precisam estar de pé. O `WorkspaceMemberGuard` já recusa
   * workspace inativo; empresa excluída/desativada o front esconde, mas o cliente MCP
   * não tem front — então a recusa é explícita aqui e no `findByHash`.
   */
  findActiveWorkspace(workspaceId: string) {
    return this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        deletedAt: null,
        isActive: true,
        company: { deletedAt: null, isActive: true },
      },
      select: { id: true, name: true, companyId: true },
    });
  }

  /**
   * Workspaces onde o usuário pode criar token — a mesma regra de `hasWorkspaceAccess`,
   * em lista: membro do workspace ou admin da empresa dona.
   */
  async findEligibleWorkspaces(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [{ resourceType: 'workspace' }, { resourceType: 'company', role: 'admin' }],
      },
      select: { resourceType: true, resourceId: true },
    });
    const workspaceIds = memberships
      .filter((m) => m.resourceType === 'workspace')
      .map((m) => m.resourceId);
    const companyIds = memberships
      .filter((m) => m.resourceType === 'company')
      .map((m) => m.resourceId);
    if (workspaceIds.length === 0 && companyIds.length === 0) return [];

    return this.prisma.workspace.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        company: { deletedAt: null, isActive: true },
        OR: [{ id: { in: workspaceIds } }, { companyId: { in: companyIds } }],
      },
      select: { id: true, name: true, company: { select: { id: true, legalName: true } } },
      orderBy: [{ company: { legalName: 'asc' } }, { name: 'asc' }],
    });
  }

  /** Mesma regra do `WorkspaceMemberGuard`: membro do workspace ou admin da empresa dona. */
  async hasWorkspaceAccess(userId: string, workspaceId: string, companyId: string) {
    const [workspaceMembership, companyAdminMembership] = await Promise.all([
      this.prisma.membership.findFirst({
        where: { userId, resourceType: 'workspace', resourceId: workspaceId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.membership.findFirst({
        where: {
          userId,
          resourceType: 'company',
          resourceId: companyId,
          role: 'admin',
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);
    return Boolean(workspaceMembership || companyAdminMembership);
  }

  /**
   * Conta e cria sob um lock por usuário: sem ele, criações simultâneas passam todas
   * pelo `count` antes de qualquer `create` e furam o teto. Devolve `null` no limite.
   */
  createWithinLimit(
    data: CreateApiTokenData,
    maxActive: number,
    now: Date,
  ): Promise<ApiTokenView | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'api_token:' + data.userId}))`;
      const active = await tx.apiToken.count({
        where: { userId: data.userId, revokedAt: null, expiresAt: { gt: now } },
      });
      if (active >= maxActive) return null;
      return tx.apiToken.create({ data, select: VIEW_SELECT });
    });
  }

  /** Revogados somem da lista; expirados continuam, para o usuário ver que venceram. */
  listByUser(userId: string): Promise<ApiTokenView[]> {
    return this.prisma.apiToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: VIEW_SELECT,
    });
  }

  revoke(userId: string, id: string, now: Date) {
    return this.prisma.apiToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  findByHash(tokenHash: string) {
    return this.prisma.apiToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        workspaceId: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            isActive: true,
            deletedAt: true,
            mustResetPassword: true,
            isSuperuser: true,
          },
        },
        workspace: {
          select: {
            deletedAt: true,
            isActive: true,
            company: { select: { deletedAt: true, isActive: true } },
          },
        },
      },
    });
  }

  touchLastUsed(id: string, now: Date) {
    return this.prisma.apiToken.update({ where: { id }, data: { lastUsedAt: now } });
  }

  findCurrent(id: string) {
    return this.prisma.apiToken.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        expiresAt: true,
        user: { select: { id: true, name: true, email: true } },
        workspace: {
          select: {
            id: true,
            name: true,
            companyId: true,
            company: { select: { legalName: true } },
          },
        },
      },
    });
  }
}
