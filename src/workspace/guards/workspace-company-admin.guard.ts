import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from '../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Allows only company admins of the workspace's parent company.
 * Workspace admins and project admins are explicitly excluded.
 */
@Injectable()
export class WorkspaceCompanyAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user: AuthUser;
      params: { workspaceId?: string };
    }>();

    const user = request.user;
    const workspaceId = request.params['workspaceId'];

    if (!workspaceId) {
      throw new ForbiddenException('Workspace não identificado');
    }

    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { companyId: true },
    });

    if (!workspace) {
      throw new ForbiddenException('Workspace não encontrado');
    }

    const companyAdmin = await this.prisma.membership.findFirst({
      where: {
        userId: user.id,
        resourceType: 'company',
        resourceId: workspace.companyId,
        role: 'admin',
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!companyAdmin) {
      throw new ForbiddenException('Acesso restrito a administradores da empresa');
    }

    return true;
  }
}
