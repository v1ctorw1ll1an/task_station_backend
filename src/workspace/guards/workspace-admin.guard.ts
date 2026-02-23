import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from '../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WorkspaceAdminGuard implements CanActivate {
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

    const [membership, workspace] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId: user.id,
          resourceType: 'workspace',
          resourceId: workspaceId,
          role: 'workspace_admin',
          deletedAt: null,
        },
      }),
      this.prisma.workspace.findFirst({
        where: { id: workspaceId, deletedAt: null, isActive: true },
      }),
    ]);

    if (!membership || !workspace) {
      throw new ForbiddenException('Acesso restrito a administradores deste workspace');
    }

    return true;
  }
}
