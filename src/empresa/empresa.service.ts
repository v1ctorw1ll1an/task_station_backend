import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
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
    @InjectPinoLogger(EmpresaService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Workspaces ────────────────────────────────────────────────────────────────

  async createWorkspace(companyId: string, dto: CreateWorkspaceDto, createdById: string) {
    const existingUser = await this.prisma.user.findFirst({
      where: { email: dto.adminEmail, deletedAt: null },
    });

    let tempPassword: string | null = null;

    if (!existingUser) {
      // Caso 1: email novo no sistema — criar usuário + vincular à empresa + vincular ao workspace
      tempPassword = crypto.randomBytes(12).toString('hex');
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      const result = await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: { name: dto.name, description: dto.description, companyId, createdById },
        });

        const admin = await tx.user.create({
          data: {
            name: dto.adminName,
            email: dto.adminEmail,
            passwordHash,
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

      this.mailerService
        .sendWelcomeEmail(dto.adminEmail, dto.adminName, tempPassword)
        .catch((err: unknown) => {
          this.logger.error(
            { adminEmail: dto.adminEmail, err },
            'Failed to send welcome email — workspace was created successfully',
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

    // Verifica se o usuário já tem membership ativo nesta empresa
    const companyMembership = await this.prisma.membership.findFirst({
      where: {
        userId: existingUser.id,
        resourceType: 'company',
        resourceId: companyId,
        deletedAt: null,
      },
    });

    if (!companyMembership) {
      // Caso 3: email existe no sistema mas não pertence a esta empresa
      throw new ConflictException(
        'Email já cadastrado no sistema mas não pertence a esta empresa',
      );
    }

    // Caso 2: email existe e já é membro da empresa — vincular apenas ao workspace
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
      'Workspace created with existing company member as admin',
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

    // Passo 1: buscar memberships da empresa
    const memberships = await this.prisma.membership.findMany({
      where: {
        resourceType: 'company',
        resourceId: companyId,
        deletedAt: null,
      },
      select: { id: true, role: true, userId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) {
      return { data: [], total: 0, page, limit };
    }

    const userIds = memberships.map((m) => m.userId);

    // Passo 2: buscar usuários com filtros
    const userWhere: {
      id: { in: string[] };
      deletedAt: null;
      isActive?: boolean;
      OR?: Array<{ name: { contains: string; mode: 'insensitive' } } | { email: { contains: string; mode: 'insensitive' } }>;
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

    const membershipMap = new Map(memberships.map((m) => [m.userId, m]));

    const data = users.map((u) => {
      const m = membershipMap.get(u.id);
      return {
        membershipId: m?.id,
        role: m?.role,
        memberSince: m?.createdAt,
        user: u,
      };
    });

    return { data, total, page, limit };
  }

  async updateMember(
    companyId: string,
    targetUserId: string,
    dto: { isActive?: boolean; deletedAt?: Date },
    performedById: string,
  ) {
    if (targetUserId === performedById) {
      throw new BadRequestException('Não é possível alterar o próprio usuário');
    }

    // Verificar que o usuário é membro desta empresa
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: targetUserId,
        resourceType: 'company',
        resourceId: companyId,
        deletedAt: null,
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

    this.logger.info(
      { companyId, targetUserId, performedById },
      'Company admin role revoked',
    );
  }
}
