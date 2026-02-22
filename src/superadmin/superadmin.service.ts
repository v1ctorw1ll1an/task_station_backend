import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class SuperadminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailerService: MailerService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    @InjectPinoLogger(SuperadminService.name)
    private readonly logger: PinoLogger,
  ) {}

  async createCompany(dto: CreateCompanyDto, createdById: string) {
    const existingCompany = await this.prisma.company.findFirst({
      where: { taxId: dto.taxId, deletedAt: null },
    });
    if (existingCompany) {
      throw new ConflictException('Já existe uma empresa com este CNPJ');
    }

    const existingUser = await this.prisma.user.findFirst({
      where: { email: dto.adminEmail, deletedAt: null },
    });

    let isNewUser = false;

    const result = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          legalName: dto.legalName,
          taxId: dto.taxId,
          createdById,
        },
      });

      let admin: { id: string; name: string; email: string };

      if (existingUser) {
        admin = existingUser;
      } else {
        isNewUser = true;
        const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        const tempName = dto.adminName ?? dto.adminEmail.split('@')[0];
        admin = await tx.user.create({
          data: {
            name: tempName,
            email: dto.adminEmail,
            passwordHash: placeholderHash,
            mustResetPassword: true,
          },
          select: { id: true, name: true, email: true },
        });
      }

      await tx.membership.create({
        data: {
          userId: admin.id,
          resourceType: 'company',
          resourceId: company.id,
          role: 'admin',
        },
      });

      return { company, admin };
    });

    let magicLink: string | null = null;

    if (isNewUser) {
      const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
      const rawToken = await this.authService.generateFirstAccessToken(result.admin.id);
      magicLink = `${frontendUrl}/first-access?token=${rawToken}`;

      this.mailerService
        .sendFirstAccessEmail(dto.adminEmail, result.admin.name, magicLink)
        .catch((err: unknown) => {
          this.logger.error(
            { adminEmail: dto.adminEmail, err },
            'Failed to send first access email — company was created successfully',
          );
        });
    }

    this.logger.info(
      {
        companyId: result.company.id,
        adminId: result.admin.id,
        adminEmail: dto.adminEmail,
        createdById,
        isNewUser,
      },
      'Company created with admin',
    );

    return {
      company: result.company,
      admin: result.admin,
      emailSent: isNewUser,
      magicLink,
    };
  }

  async listCompanies(query: ListCompaniesQueryDto) {
    const { search, isActive, page = 1, limit = 20 } = query;

    const where: Prisma.CompanyWhereInput = {
      deletedAt: null,
    };

    if (search) {
      where.OR = [
        { legalName: { contains: search, mode: 'insensitive' } },
        { taxId: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.company.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async updateCompany(id: string, dto: UpdateCompanyDto) {
    const company = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
    });
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    if (dto.taxId && dto.taxId !== company.taxId) {
      const conflict = await this.prisma.company.findFirst({
        where: { taxId: dto.taxId, deletedAt: null, id: { not: id } },
      });
      if (conflict) {
        throw new ConflictException('Já existe uma empresa com este CNPJ');
      }
    }

    const updated = await this.prisma.company.update({
      where: { id },
      data: dto,
    });

    this.logger.info({ companyId: id, changes: dto }, 'Company updated');
    return updated;
  }

  async deactivateCompany(id: string, performedById: string) {
    const company = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
    });
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    const updated = await this.prisma.company.update({
      where: { id },
      data: { isActive: false },
    });

    this.logger.info({ companyId: id, performedById }, 'Company deactivated');
    return updated;
  }

  async deleteCompany(id: string, performedById: string) {
    const company = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
    });
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    await this.prisma.company.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    this.logger.info({ companyId: id, performedById }, 'Company soft-deleted');
  }

  async listUsers(query: ListUsersQueryDto) {
    const { search, isActive, page = 1, limit = 20 } = query;

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isActive: true,
          isSuperuser: true,
          mustResetPassword: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: users, total, page, limit };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (dto.email && dto.email !== user.email) {
      const conflict = await this.prisma.user.findFirst({
        where: { email: dto.email, deletedAt: null, id: { not: userId } },
      });
      if (conflict) {
        throw new ConflictException('Já existe um usuário com este email');
      }
    }

    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };

    if (password) {
      data.passwordHash = await bcrypt.hash(password, 10);
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        isSuperuser: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.info({ userId, changes: Object.keys(dto) }, 'Superuser updated own profile');
    return updated;
  }

  async getUserDetail(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        isSuperuser: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
        memberships: {
          where: {
            deletedAt: null,
            resourceType: 'company',
          },
          select: {
            id: true,
            role: true,
            resourceType: true,
            resourceId: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    // Buscar dados das empresas vinculadas
    const companyIds = user.memberships.map((m) => m.resourceId);
    const companies = await this.prisma.company.findMany({
      where: { id: { in: companyIds }, deletedAt: null },
      select: { id: true, legalName: true, taxId: true, isActive: true },
    });

    const companyMap = new Map(companies.map((c) => [c.id, c]));

    const memberships = user.memberships.map((m) => ({
      ...m,
      company: companyMap.get(m.resourceId) ?? null,
    }));

    return { ...user, memberships };
  }

  async getCompanyDetail(id: string) {
    const company = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        legalName: true,
        taxId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        createdBy: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    const [admins, workspacesCount, projectsCount] = await Promise.all([
      this.prisma.membership.findMany({
        where: {
          resourceType: 'company',
          resourceId: id,
          deletedAt: null,
        },
        select: {
          id: true,
          role: true,
          createdAt: true,
          user: {
            select: { id: true, name: true, email: true, phone: true, isActive: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.workspace.count({
        where: { companyId: id, deletedAt: null },
      }),
      this.prisma.project.count({
        where: {
          workspace: { companyId: id, deletedAt: null },
          deletedAt: null,
        },
      }),
    ]);

    const adminsFormatted = admins.map((m) => ({
      membershipId: m.id,
      role: m.role,
      createdAt: m.createdAt,
      user: m.user,
    }));

    return { ...company, admins: adminsFormatted, workspacesCount, projectsCount };
  }

  async deactivateMembership(companyId: string, membershipId: string, performedById: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, resourceType: 'company', resourceId: companyId, deletedAt: null },
    });

    if (!membership) {
      throw new NotFoundException('Vínculo não encontrado');
    }

    // Verifica se é o único admin ativo da empresa
    const activeAdminsCount = await this.prisma.membership.count({
      where: {
        resourceType: 'company',
        resourceId: companyId,
        deletedAt: null,
        id: { not: membershipId },
      },
    });

    if (activeAdminsCount === 0) {
      throw new BadRequestException(
        'Não é possível inativar o único administrador da empresa. Adicione outro administrador primeiro.',
      );
    }

    await this.prisma.membership.update({
      where: { id: membershipId },
      data: { deletedAt: new Date() },
    });

    this.logger.info(
      { companyId, membershipId, performedById },
      'Company membership deactivated by superadmin',
    );
  }

  async updateUser(id: string, dto: UpdateUserDto, currentUserId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (id === currentUserId) {
      throw new BadRequestException('Não é possível alterar o próprio usuário');
    }

    if (dto.email && dto.email !== user.email) {
      const conflict = await this.prisma.user.findFirst({
        where: { email: dto.email, deletedAt: null, id: { not: id } },
      });
      if (conflict) {
        throw new ConflictException('Já existe um usuário com este email');
      }
    }

    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };

    if (password) {
      data.passwordHash = await bcrypt.hash(password, 10);
      data.mustResetPassword = true;
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isActive: true,
        isSuperuser: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });

    this.logger.info(
      { targetUserId: id, changes: Object.keys(dto), performedById: currentUserId },
      'User updated by superadmin',
    );
    return updated;
  }

  async invalidateUserCredentials(targetUserId: string, performedById: string) {
    const rawToken = await this.authService.invalidateUserCredentials(targetUserId, performedById);
    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    return { magicLink: `${frontendUrl}/first-access?token=${rawToken}` };
  }

  async getMagicLink(targetUserId: string) {
    const rawToken = await this.authService.getOrRegenerateFirstAccessToken(targetUserId);
    if (!rawToken) {
      return { magicLink: null };
    }
    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    return { magicLink: `${frontendUrl}/first-access?token=${rawToken}` };
  }
}
