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
import { SuperadminRepository } from './superadmin.repository';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class SuperadminService {
  constructor(
    private readonly repo: SuperadminRepository,
    private readonly mailerService: MailerService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    @InjectPinoLogger(SuperadminService.name)
    private readonly logger: PinoLogger,
  ) {}

  async createCompany(dto: CreateCompanyDto, createdById: string) {
    const existingCompany = await this.repo.findCompanyByTaxId(dto.taxId);
    if (existingCompany) {
      throw new ConflictException('Já existe uma empresa com este CNPJ');
    }

    const existingUser = await this.repo.findUserByEmail(dto.adminEmail);

    let company: { id: string; legalName: string; taxId: string };
    let admin: { id: string; name: string; email: string };
    let isNewUser = false;

    if (existingUser) {
      company = await this.repo.createCompanyWithAdmin(
        { legalName: dto.legalName, taxId: dto.taxId, createdById },
        existingUser.id,
      );
      admin = existingUser;
    } else {
      isNewUser = true;
      const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const tempName = dto.adminName ?? dto.adminEmail.split('@')[0];
      const result = await this.repo.createCompanyWithNewAdmin(
        { legalName: dto.legalName, taxId: dto.taxId, createdById },
        {
          name: tempName,
          email: dto.adminEmail,
          passwordHash: placeholderHash,
          mustResetPassword: true,
        },
      );
      company = result.company;
      admin = result.admin;
    }

    let magicLink: string | null = null;

    if (isNewUser) {
      const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
      const rawToken = await this.authService.generateFirstAccessToken(admin.id);
      magicLink = `${frontendUrl}/first-access?token=${rawToken}`;

      this.mailerService
        .sendFirstAccessEmail(dto.adminEmail, admin.name, magicLink)
        .catch((err: unknown) => {
          this.logger.error(
            { adminEmail: dto.adminEmail, err },
            'Failed to send first access email — company was created successfully',
          );
        });
    }

    this.logger.info(
      {
        companyId: company.id,
        adminId: admin.id,
        adminEmail: dto.adminEmail,
        createdById,
        isNewUser,
      },
      'Company created with admin',
    );

    return { company, admin, emailSent: isNewUser, magicLink };
  }

  async listCompanies(query: ListCompaniesQueryDto) {
    const { search, isActive, page = 1, limit = 20 } = query;

    const where: Prisma.CompanyWhereInput = { deletedAt: null };

    if (search) {
      where.OR = [
        { legalName: { contains: search, mode: 'insensitive' } },
        { taxId: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await this.repo.findCompanies(where, page, limit);
    return { data, total, page, limit };
  }

  async updateCompany(id: string, dto: UpdateCompanyDto) {
    const company = await this.repo.findCompanyById(id);
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    if (dto.taxId && dto.taxId !== company.taxId) {
      const conflict = await this.repo.findCompanyByTaxIdExcluding(dto.taxId, id);
      if (conflict) {
        throw new ConflictException('Já existe uma empresa com este CNPJ');
      }
    }

    const updated = await this.repo.updateCompany(id, dto);
    this.logger.info({ companyId: id, changes: dto }, 'Company updated');
    return updated;
  }

  async deactivateCompany(id: string, performedById: string) {
    const company = await this.repo.findCompanyById(id);
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    const updated = await this.repo.updateCompany(id, { isActive: false });
    this.logger.info({ companyId: id, performedById }, 'Company deactivated');
    return updated;
  }

  async deleteCompany(id: string, performedById: string) {
    const company = await this.repo.findCompanyById(id);
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    await this.repo.updateCompany(id, { deletedAt: new Date() });
    this.logger.info({ companyId: id, performedById }, 'Company soft-deleted');
  }

  async listUsers(query: ListUsersQueryDto) {
    const { search, isActive, page = 1, limit = 20 } = query;

    const where: Prisma.UserWhereInput = { deletedAt: null };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [users, total] = await this.repo.findUsers(where, page, limit);
    return { data: users, total, page, limit };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.repo.findUserById(userId);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (dto.email && dto.email !== user.email) {
      const conflict = await this.repo.findUserByEmailExcluding(dto.email, userId);
      if (conflict) {
        throw new ConflictException('Já existe um usuário com este email');
      }
    }

    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };

    if (password) {
      data.passwordHash = await bcrypt.hash(password, 10);
    }

    const updated = await this.repo.updateProfile(userId, data);
    this.logger.info({ userId, changes: Object.keys(dto) }, 'Superuser updated own profile');
    return updated;
  }

  async getUserDetail(id: string) {
    const user = await this.repo.findUserDetail(id);

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const companyIds = user.memberships.map((m) => m.resourceId);
    const companies = await this.repo.findCompaniesByIds(companyIds);

    const companyMap = new Map(companies.map((c) => [c.id, c]));

    const memberships = user.memberships.map((m) => ({
      ...m,
      company: companyMap.get(m.resourceId) ?? null,
    }));

    return { ...user, memberships };
  }

  async getCompanyDetail(id: string) {
    const company = await this.repo.findCompanyDetail(id);

    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }

    const [admins, workspacesCount, projectsCount] = await Promise.all([
      this.repo.findCompanyMemberships(id),
      this.repo.countWorkspacesByCompany(id),
      this.repo.countProjectsByCompany(id),
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
    const membership = await this.repo.findMembership({
      id: membershipId,
      resourceType: 'company',
      resourceId: companyId,
      deletedAt: null,
    });

    if (!membership) {
      throw new NotFoundException('Vínculo não encontrado');
    }

    const activeAdminsCount = await this.repo.countMemberships({
      resourceType: 'company',
      resourceId: companyId,
      deletedAt: null,
      id: { not: membershipId },
    });

    if (activeAdminsCount === 0) {
      throw new BadRequestException(
        'Não é possível inativar o único administrador da empresa. Adicione outro administrador primeiro.',
      );
    }

    await this.repo.updateMembership(membershipId, { deletedAt: new Date() });

    this.logger.info(
      { companyId, membershipId, performedById },
      'Company membership deactivated by superadmin',
    );
  }

  async updateUser(id: string, dto: UpdateUserDto, currentUserId: string) {
    const user = await this.repo.findUserById(id);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (id === currentUserId) {
      throw new BadRequestException('Não é possível alterar o próprio usuário');
    }

    if (dto.email && dto.email !== user.email) {
      const conflict = await this.repo.findUserByEmailExcluding(dto.email, id);
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

    const updated = await this.repo.updateUser(id, data);

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
