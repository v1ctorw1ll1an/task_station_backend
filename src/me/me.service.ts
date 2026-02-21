import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(MeService.name)
    private readonly logger: PinoLogger,
  ) {}

  async getMyCompanies(userId: string) {
    // Passo 1: buscar memberships de admin ativas do usuário
    const memberships = await this.prisma.membership.findMany({
      where: {
        userId,
        resourceType: 'company',
        role: 'admin',
        deletedAt: null,
      },
      select: { resourceId: true, role: true },
    });

    if (memberships.length === 0) {
      return [];
    }

    const companyIds = memberships.map((m) => m.resourceId);

    // Passo 2: buscar empresas ativas
    const companies = await this.prisma.company.findMany({
      where: { id: { in: companyIds }, deletedAt: null, isActive: true },
      select: { id: true, legalName: true },
      orderBy: { legalName: 'asc' },
    });

    const membershipMap = new Map(memberships.map((m) => [m.resourceId, m.role]));

    this.logger.info({ userId, count: companies.length }, 'User company list fetched');

    return companies.map((c) => ({
      companyId: c.id,
      legalName: c.legalName,
      role: membershipMap.get(c.id),
    }));
  }
}
