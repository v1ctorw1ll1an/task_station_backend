import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from '../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProjetoAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user: AuthUser;
      params: { projectId?: string };
    }>();

    const user = request.user;
    const projectId = request.params['projectId'];

    if (!projectId) {
      throw new ForbiddenException('Projeto não identificado');
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        workspaceId: true,
        workspace: { select: { companyId: true } },
      },
    });

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    // workspace_admin OU project_admin neste projeto OU admin da empresa
    const [workspaceAdminMembership, projectAdminMembership, companyAdminMembership] =
      await Promise.all([
        this.prisma.membership.findFirst({
          where: {
            userId: user.id,
            resourceType: 'workspace',
            resourceId: project.workspaceId,
            role: 'workspace_admin',
            deletedAt: null,
          },
          select: { id: true },
        }),
        this.prisma.membership.findFirst({
          where: {
            userId: user.id,
            resourceType: 'project',
            resourceId: projectId,
            role: 'project_admin',
            deletedAt: null,
          },
          select: { id: true },
        }),
        this.prisma.membership.findFirst({
          where: {
            userId: user.id,
            resourceType: 'company',
            resourceId: project.workspace.companyId,
            role: 'admin',
            deletedAt: null,
          },
          select: { id: true },
        }),
      ]);

    if (!workspaceAdminMembership && !projectAdminMembership && !companyAdminMembership) {
      throw new ForbiddenException('Acesso restrito a administradores deste projeto');
    }

    return true;
  }
}
