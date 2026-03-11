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
export class ProjetoMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user: AuthUser;
      params: { projectId?: string };
      projectMemberRole?: string;
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

    // Verificar membership no workspace OU admin da empresa
    const [workspaceMembership, companyAdminMembership] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId: user.id,
          resourceType: 'workspace',
          resourceId: project.workspaceId,
          deletedAt: null,
        },
        select: { role: true },
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

    if (!workspaceMembership && !companyAdminMembership) {
      throw new ForbiddenException('Acesso restrito a membros deste projeto');
    }

    // Company admin gets workspace_admin role downstream; others check project restriction
    if (companyAdminMembership && !workspaceMembership) {
      request.projectMemberRole = 'workspace_admin';
      return true;
    }

    // Check project restriction (unless workspace_admin or company_admin)
    const role = workspaceMembership!.role;
    if (role !== 'workspace_admin') {
      const restriction = await this.prisma.projectRestriction.findUnique({
        where: { userId_projectId: { userId: user.id, projectId } },
      });
      if (restriction) {
        throw new ForbiddenException('Acesso restrito a este projeto');
      }
    }

    request.projectMemberRole = role;
    return true;
  }
}
