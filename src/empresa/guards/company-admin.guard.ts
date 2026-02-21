import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from '../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CompanyAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user: AuthUser;
      params: { companyId?: string };
    }>();

    const user = request.user;
    const companyId = request.params['companyId'];

    if (!companyId) {
      throw new ForbiddenException('Empresa não identificada');
    }

    const [membership, company] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId: user.id,
          resourceType: 'company',
          resourceId: companyId,
          role: 'admin',
          deletedAt: null,
        },
      }),
      this.prisma.company.findFirst({
        where: { id: companyId, deletedAt: null, isActive: true },
      }),
    ]);

    if (!membership || !company) {
      throw new ForbiddenException('Acesso restrito a administradores desta empresa');
    }

    return true;
  }
}
