import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResourceType } from '../generated/prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { ListWorkspacesQueryDto } from './dto/list-workspaces-query.dto';
import { PromoteMemberDto } from './dto/promote-member.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@Injectable()
export class EmpresaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailerService: MailerService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    @InjectPinoLogger(EmpresaService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Workspaces ────────────────────────────────────────────────────────────────

  async createWorkspace(companyId: string, dto: CreateWorkspaceDto, createdById: string) {
    const existingUser = await this.prisma.user.findFirst({
      where: { email: dto.adminEmail, deletedAt: null },
    });

    if (!existingUser) {
      // Caso 1: email novo no sistema — criar usuário + vincular à empresa + vincular ao workspace
      const tempName = dto.adminEmail.split('@')[0];
      const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

      const result = await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: { name: dto.name, description: dto.description, companyId, createdById },
        });

        const admin = await tx.user.create({
          data: {
            name: tempName,
            email: dto.adminEmail,
            passwordHash: placeholderHash,
            mustResetPassword: true,
          },
        });

        await tx.membership.create({
          data: {
            userId: admin.id,
            resourceType: 'company',
            resourceId: companyId,
            role: 'member',
          },
        });

        await tx.membership.create({
          data: {
            userId: admin.id,
            resourceType: 'workspace',
            resourceId: workspace.id,
            role: 'workspace_admin',
          },
        });

        return { workspace, admin };
      });

      const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
      const rawToken = await this.authService.generateFirstAccessToken(result.admin.id);
      const magicLink = `${frontendUrl}/first-access?token=${rawToken}`;

      this.mailerService
        .sendFirstAccessEmail(dto.adminEmail, tempName, magicLink)
        .catch((err: unknown) => {
          this.logger.error(
            { adminEmail: dto.adminEmail, err },
            'Failed to send first access email — workspace was created successfully',
          );
        });

      this.logger.info(
        { companyId, workspaceId: result.workspace.id, adminId: result.admin.id, createdById },
        'Workspace created with new admin user',
      );

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { passwordHash: _ph, ...adminWithoutPassword } = result.admin;
      return { workspace: result.workspace, admin: adminWithoutPassword };
    }

    // Caso 2: email já existe no sistema — vincular diretamente ao workspace como workspace_admin
    const workspace = await this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: { name: dto.name, description: dto.description, companyId, createdById },
      });

      await tx.membership.create({
        data: {
          userId: existingUser.id,
          resourceType: 'workspace',
          resourceId: ws.id,
          role: 'workspace_admin',
        },
      });

      return ws;
    });

    this.logger.info(
      { companyId, workspaceId: workspace.id, adminId: existingUser.id, createdById },
      'Workspace created with existing user as workspace admin',
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _ph, ...adminWithoutPassword } = existingUser;
    return { workspace, admin: adminWithoutPassword };
  }

  async listWorkspaces(companyId: string, query: ListWorkspacesQueryDto) {
    const { isActive, page = 1, limit = 20 } = query;

    const where: {
      companyId: string;
      deletedAt: null;
      isActive?: boolean;
    } = { companyId, deletedAt: null };

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await Promise.all([
      this.prisma.workspace.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          description: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.workspace.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getWorkspace(companyId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    return workspace;
  }

  async updateWorkspace(companyId: string, workspaceId: string, dto: UpdateWorkspaceDto) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: dto,
      select: {
        id: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.info({ companyId, workspaceId, changes: dto }, 'Workspace updated');
    return updated;
  }

  async deactivateWorkspace(companyId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { isActive: false },
      select: {
        id: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.info({ companyId, workspaceId }, 'Workspace deactivated');
    return updated;
  }

  async activateWorkspace(companyId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.info({ companyId, workspaceId }, 'Workspace activated');
    return updated;
  }

  async deleteWorkspace(companyId: string, workspaceId: string, performedById: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { deletedAt: new Date() },
    });

    this.logger.info({ companyId, workspaceId, performedById }, 'Workspace soft-deleted');
  }

  // ── Membros ───────────────────────────────────────────────────────────────────

  async listMembers(companyId: string, query: ListMembersQueryDto) {
    const { search, isActive, page = 1, limit = 20 } = query;

    // Passo 1: buscar workspaces desta empresa (não deletados)
    const workspaces = await this.prisma.workspace.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true },
    });
    const workspaceIds = workspaces.map((w) => w.id);
    const workspaceNameMap = new Map(workspaces.map((w) => [w.id, w.name]));

    // Passo 2: buscar todos os memberships relativos a esta empresa
    // (membership direto na empresa OU em qualquer workspace dela)
    const memberships = await this.prisma.membership.findMany({
      where: {
        deletedAt: null,
        OR: [
          { resourceType: 'company', resourceId: companyId },
          ...(workspaceIds.length > 0
            ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
            : []),
        ],
      },
      select: {
        id: true,
        role: true,
        userId: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
      },
    });

    if (memberships.length === 0) {
      return { data: [], total: 0, page, limit };
    }

    // Passo 3: consolidar por userId — manter o role mais alto e a data mais antiga
    // e acumular papéis de workspace
    const roleRank: Record<string, number> = { admin: 3, workspace_admin: 2, member: 1 };
    const consolidatedMap = new Map<string, { id: string; role: string; createdAt: Date }>();
    const workspaceRolesMap = new Map<
      string,
      Array<{ workspaceId: string; workspaceName: string; role: string; membershipId: string }>
    >();

    for (const m of memberships) {
      // Acumular papel de workspace por usuário
      if (m.resourceType === ResourceType.workspace) {
        const existing = workspaceRolesMap.get(m.userId) ?? [];
        existing.push({
          workspaceId: m.resourceId,
          workspaceName: workspaceNameMap.get(m.resourceId) ?? m.resourceId,
          role: m.role,
          membershipId: m.id,
        });
        workspaceRolesMap.set(m.userId, existing);
      }

      const existingConsolidated = consolidatedMap.get(m.userId);
      const rank = roleRank[m.role] ?? 0;
      if (!existingConsolidated) {
        consolidatedMap.set(m.userId, { id: m.id, role: m.role, createdAt: m.createdAt });
      } else {
        const existingRank = roleRank[existingConsolidated.role] ?? 0;
        if (rank > existingRank) {
          consolidatedMap.set(m.userId, {
            id: m.id,
            role: m.role,
            createdAt: existingConsolidated.createdAt,
          });
        } else if (m.createdAt < existingConsolidated.createdAt) {
          // Mesma hierarquia — guardar data mais antiga
          consolidatedMap.set(m.userId, { ...existingConsolidated, createdAt: m.createdAt });
        }
      }
    }

    const userIds = Array.from(consolidatedMap.keys());

    // Passo 4: buscar usuários com filtros
    const userWhere: {
      id: { in: string[] };
      deletedAt: null;
      isActive?: boolean;
      OR?: Array<
        | { name: { contains: string; mode: 'insensitive' } }
        | { email: { contains: string; mode: 'insensitive' } }
      >;
    } = { id: { in: userIds }, deletedAt: null };

    if (isActive !== undefined) {
      userWhere.isActive = isActive;
    }

    if (search) {
      userWhere.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where: userWhere,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isActive: true,
          mustResetPassword: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where: userWhere }),
    ]);

    const data = users.map((u) => {
      const m = consolidatedMap.get(u.id);
      return {
        membershipId: m?.id,
        role: m?.role,
        memberSince: m?.createdAt,
        workspaceRoles: workspaceRolesMap.get(u.id) ?? [],
        user: u,
      };
    });

    return { data, total, page, limit };
  }

  /** Lança ForbiddenException se targetUserId for admin ativo desta empresa */
  private async assertNotCompanyAdmin(companyId: string, targetUserId: string) {
    const isAdmin = await this.prisma.membership.findFirst({
      where: {
        userId: targetUserId,
        resourceType: ResourceType.company,
        resourceId: companyId,
        role: 'admin',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (isAdmin) {
      throw new ForbiddenException(
        'Não é possível alterar os papéis de um administrador da empresa',
      );
    }
  }

  async updateMember(
    companyId: string,
    targetUserId: string,
    dto: { isActive?: boolean },
    performedById: string,
  ) {
    if (targetUserId === performedById) {
      throw new BadRequestException('Não é possível alterar o próprio usuário');
    }

    await this.assertNotCompanyAdmin(companyId, targetUserId);

    // Verificar que o usuário tem algum membership nesta empresa (direto ou via workspace)
    const workspaces = await this.prisma.workspace.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((w) => w.id);

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: targetUserId,
        deletedAt: null,
        OR: [
          { resourceType: 'company', resourceId: companyId },
          ...(workspaceIds.length > 0
            ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
            : []),
        ],
      },
    });

    if (!membership) {
      throw new NotFoundException('Membro não encontrado nesta empresa');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: dto,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.info(
      { companyId, targetUserId, changes: Object.keys(dto), performedById },
      'Company member updated',
    );
    return updated;
  }

  async removeMember(companyId: string, targetUserId: string, performedById: string) {
    if (targetUserId === performedById) {
      throw new BadRequestException('Não é possível remover a si mesmo da empresa');
    }

    await this.assertNotCompanyAdmin(companyId, targetUserId);

    // Buscar todos os workspaces desta empresa
    const workspaces = await this.prisma.workspace.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((w) => w.id);

    // Soft delete de todos os memberships do usuário nesta empresa (company + workspaces)
    const result = await this.prisma.membership.updateMany({
      where: {
        userId: targetUserId,
        deletedAt: null,
        OR: [
          { resourceType: 'company', resourceId: companyId },
          ...(workspaceIds.length > 0
            ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
            : []),
        ],
      },
      data: { deletedAt: new Date() },
    });

    if (result.count === 0) {
      throw new NotFoundException('Membro não encontrado nesta empresa');
    }

    this.logger.info(
      { companyId, targetUserId, performedById, membershipsRevoked: result.count },
      'Member removed from company and all its workspaces',
    );
  }

  // ── Admins ────────────────────────────────────────────────────────────────────

  async promoteToAdmin(companyId: string, dto: PromoteMemberDto, performedById: string) {
    const { userId } = dto;

    // Verificar que o usuário é membro desta empresa
    const companyMembership = await this.prisma.membership.findFirst({
      where: {
        userId,
        resourceType: 'company',
        resourceId: companyId,
        deletedAt: null,
      },
    });

    if (!companyMembership) {
      throw new NotFoundException('Usuário não é membro desta empresa');
    }

    // Verificar se já é admin ativo
    const existingAdmin = await this.prisma.membership.findFirst({
      where: {
        userId,
        resourceType: 'company',
        resourceId: companyId,
        role: 'admin',
        deletedAt: null,
      },
    });

    if (existingAdmin) {
      throw new ConflictException('Usuário já é administrador desta empresa');
    }

    const membership = await this.prisma.membership.create({
      data: {
        userId,
        resourceType: 'company',
        resourceId: companyId,
        role: 'admin',
      },
      select: {
        id: true,
        userId: true,
        role: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
      },
    });

    this.logger.info(
      { companyId, promotedUserId: userId, performedById },
      'User promoted to company admin',
    );
    return membership;
  }

  async revokeAdmin(companyId: string, targetUserId: string, performedById: string) {
    if (targetUserId === performedById) {
      throw new BadRequestException('Não é possível revogar o próprio papel de administrador');
    }

    const adminMembership = await this.prisma.membership.findFirst({
      where: {
        userId: targetUserId,
        resourceType: 'company',
        resourceId: companyId,
        role: 'admin',
        deletedAt: null,
      },
    });

    if (!adminMembership) {
      throw new NotFoundException('Papel de administrador não encontrado para este usuário');
    }

    // Verificar se é o único admin ativo
    const activeAdminsCount = await this.prisma.membership.count({
      where: {
        resourceType: 'company',
        resourceId: companyId,
        role: 'admin',
        deletedAt: null,
        id: { not: adminMembership.id },
      },
    });

    if (activeAdminsCount === 0) {
      throw new BadRequestException(
        'Não é possível revogar o único administrador. Adicione outro administrador primeiro.',
      );
    }

    await this.prisma.membership.update({
      where: { id: adminMembership.id },
      data: { deletedAt: new Date() },
    });

    this.logger.info({ companyId, targetUserId, performedById }, 'Company admin role revoked');
  }

  /**
   * Retorna todos os papéis de um membro nesta empresa:
   * - papel na empresa (admin | member | null se veio só via workspace)
   * - papel em cada workspace (workspace_admin | member | null se não é membro)
   */
  async getMemberRoles(companyId: string, targetUserId: string) {
    // Verificar que o usuário existe
    const user = await this.prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    // Buscar todos os workspaces da empresa
    const workspaces = await this.prisma.workspace.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    const workspaceIds = workspaces.map((w) => w.id);

    // Buscar todos os memberships do usuário nesta empresa
    const memberships = await this.prisma.membership.findMany({
      where: {
        userId: targetUserId,
        deletedAt: null,
        OR: [
          { resourceType: ResourceType.company, resourceId: companyId },
          ...(workspaceIds.length > 0
            ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
            : []),
        ],
      },
      select: { id: true, resourceType: true, resourceId: true, role: true },
    });

    const companyMembership = memberships.find((m) => m.resourceType === ResourceType.company);
    const workspaceMembershipsMap = new Map(
      memberships
        .filter((m) => m.resourceType === ResourceType.workspace)
        .map((m) => [m.resourceId, m]),
    );

    const workspaceRoles = workspaces.map((ws) => {
      const m = workspaceMembershipsMap.get(ws.id);
      return {
        workspaceId: ws.id,
        workspaceName: ws.name,
        isActive: ws.isActive,
        membershipId: m?.id ?? null,
        role: m?.role ?? null,
      };
    });

    return {
      user,
      companyRole: companyMembership?.role ?? null,
      companyMembershipId: companyMembership?.id ?? null,
      workspaceRoles,
    };
  }

  async promoteToWorkspaceAdmin(
    companyId: string,
    workspaceId: string,
    userId: string,
    performedById: string,
  ) {
    await this.assertNotCompanyAdmin(companyId, userId);

    // Verificar workspace pertence à empresa
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
    });
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    // Verificar que o usuário é membro desta empresa (qualquer forma)
    const workspaceIds = (
      await this.prisma.workspace.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true },
      })
    ).map((w) => w.id);

    const anyMembership = await this.prisma.membership.findFirst({
      where: {
        userId,
        deletedAt: null,
        OR: [
          { resourceType: ResourceType.company, resourceId: companyId },
          ...(workspaceIds.length > 0
            ? [{ resourceType: ResourceType.workspace, resourceId: { in: workspaceIds } }]
            : []),
        ],
      },
    });
    if (!anyMembership) throw new NotFoundException('Usuário não é membro desta empresa');

    // Verificar se já tem qualquer membership ativo neste workspace
    const existing = await this.prisma.membership.findFirst({
      where: {
        userId,
        resourceType: ResourceType.workspace,
        resourceId: workspaceId,
        deletedAt: null,
      },
    });
    if (existing) {
      if (existing.role === 'workspace_admin') {
        throw new ConflictException('Usuário já é administrador deste workspace');
      }
      // Promover membership existente a workspace_admin
      const updated = await this.prisma.membership.update({
        where: { id: existing.id },
        data: { role: 'workspace_admin' },
        select: { id: true, userId: true, role: true, resourceId: true, createdAt: true },
      });
      this.logger.info(
        { companyId, workspaceId, userId, performedById },
        'User promoted to workspace_admin (existing membership upgraded)',
      );
      return updated;
    }

    // Garantir membership na empresa como member (se não existir)
    const companyMembership = await this.prisma.membership.findFirst({
      where: { userId, resourceType: ResourceType.company, resourceId: companyId, deletedAt: null },
    });
    if (!companyMembership) {
      await this.prisma.membership.create({
        data: { userId, resourceType: ResourceType.company, resourceId: companyId, role: 'member' },
      });
    }

    const membership = await this.prisma.membership.create({
      data: {
        userId,
        resourceType: ResourceType.workspace,
        resourceId: workspaceId,
        role: 'workspace_admin',
      },
      select: { id: true, userId: true, role: true, resourceId: true, createdAt: true },
    });

    this.logger.info(
      { companyId, workspaceId, userId, performedById },
      'User promoted to workspace_admin',
    );
    return membership;
  }

  async revokeWorkspaceAdmin(
    companyId: string,
    workspaceId: string,
    targetUserId: string,
    performedById: string,
  ) {
    await this.assertNotCompanyAdmin(companyId, targetUserId);

    // Verificar workspace pertence à empresa
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, companyId, deletedAt: null },
    });
    if (!workspace) throw new NotFoundException('Workspace não encontrado');

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: targetUserId,
        resourceType: ResourceType.workspace,
        resourceId: workspaceId,
        role: 'workspace_admin',
        deletedAt: null,
      },
    });
    if (!membership)
      throw new NotFoundException('Papel de workspace_admin não encontrado para este usuário');

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { deletedAt: new Date() },
    });

    this.logger.info(
      { companyId, workspaceId, targetUserId, performedById },
      'Workspace admin role revoked',
    );
  }
}
