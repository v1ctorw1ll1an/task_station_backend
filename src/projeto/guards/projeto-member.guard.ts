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
      select: { workspaceId: true },
    });

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: user.id,
        resourceType: 'workspace',
        resourceId: project.workspaceId,
        deletedAt: null,
      },
      select: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('Acesso restrito a membros deste projeto');
    }

    request.projectMemberRole = membership.role;

    return true;
  }
}
