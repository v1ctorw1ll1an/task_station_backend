import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class SuperadminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailerService: MailerService,
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
    if (existingUser) {
      throw new ConflictException('Já existe um usuário com este email');
    }

    const tempPassword = crypto.randomBytes(12).toString('hex');
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          legalName: dto.legalName,
          taxId: dto.taxId,
          createdById,
        },
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
          resourceId: company.id,
          role: 'admin',
        },
      });

      return { company, admin };
    });

    this.mailerService
      .sendWelcomeEmail(dto.adminEmail, dto.adminName, tempPassword)
      .catch((err: unknown) => {
        this.logger.error(
          { adminEmail: dto.adminEmail, err },
          'Failed to send welcome email — company was created successfully',
        );
      });

    this.logger.info(
      {
        companyId: result.company.id,
        adminId: result.admin.id,
        adminEmail: dto.adminEmail,
        createdById,
      },
      'Company created with admin',
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _ph, ...adminWithoutPassword } = result.admin;
    return { company: result.company, admin: adminWithoutPassword };
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

    const updated = await this.prisma.user.update({
      where: { id },
      data: dto,
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        isSuperuser: true,
        mustResetPassword: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });

    this.logger.info(
      { targetUserId: id, changes: dto, performedById: currentUserId },
      'User updated by superadmin',
    );
    return updated;
  }
}
