import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { BillingAccessService } from '../billing/billing-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { KanbanGateway } from '../projeto/kanban.gateway';
import type {
  TaskSessionStartedPayload,
  TaskSessionPausedPayload,
  TaskSessionResumedPayload,
  TaskSessionStoppedPayload,
} from '../projeto/kanban-events.types';

const MAX_ACTIVE_SESSIONS = 3;

const TASK_SELECT = {
  id: true,
  title: true,
  taskNumber: true,
  project: {
    select: {
      id: true,
      name: true,
      workspaceId: true,
      workspace: { select: { id: true, name: true, companyId: true } },
    },
  },
} as const;

const USER_SELECT = {
  id: true,
  name: true,
  photoUrl: true,
} as const;

const SESSION_INCLUDE = {
  task: { select: TASK_SELECT },
  user: { select: USER_SELECT },
} as const;

@Injectable()
export class TaskSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: KanbanGateway,
    private readonly access: BillingAccessService,
    @InjectPinoLogger(TaskSessionService.name)
    private readonly logger: PinoLogger,
  ) {}

  async start(userId: string, taskId: string) {
    // Verify task exists and is accessible
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: TASK_SELECT,
    });

    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    // Empresa em somente-leitura não INICIA rastreio novo (é criação). Pausar,
    // retomar e parar seguem liberados — senão o cronômetro ficaria rodando para
    // sempre em quem já estava com uma sessão aberta.
    await this.access.assertCanMutate(task.project.workspace.companyId);

    // Validate max sessions limit
    const activeCount = await this.prisma.taskSession.count({
      where: { userId, status: { in: ['running', 'paused'] } },
    });

    if (activeCount >= MAX_ACTIVE_SESSIONS) {
      throw new BadRequestException(
        `Limite de ${MAX_ACTIVE_SESSIONS} tarefas simultâneas atingido`,
      );
    }

    const now = new Date();
    const session = await this.prisma.taskSession.create({
      data: {
        taskId,
        userId,
        status: 'running',
        startedAt: now,
        resumedAt: now,
        totalSeconds: 0,
      },
      include: SESSION_INCLUDE,
    });

    this.logger.info({ userId, taskId, sessionId: session.id }, 'Sessão de task iniciada');

    const user = session.user;
    const companyId = task.project.workspace.companyId;
    const payload: TaskSessionStartedPayload = {
      sessionId: session.id,
      taskId: task.id,
      taskTitle: task.title,
      taskNumber: task.taskNumber,
      projectId: task.project.id,
      projectName: task.project.name,
      workspaceId: task.project.workspaceId,
      workspaceName: task.project.workspace.name,
      companyId,
      userId,
      userName: user.name,
      userPhotoUrl: user.photoUrl,
      status: 'running',
      resumedAt: now.toISOString(),
      totalSeconds: 0,
    };

    this.gateway.emitToProject(task.project.id, 'taskSession:started', payload);
    this.gateway.emitToWorkspace(task.project.workspaceId, 'taskSession:started', payload);
    this.gateway.emitToCompany(companyId, 'taskSession:started', payload);

    return session;
  }

  async pause(userId: string, sessionId: string) {
    const session = await this.findOwnedSession(userId, sessionId);

    if (session.status !== 'running') {
      throw new BadRequestException('Sessão não está em execução');
    }

    const now = new Date();
    const elapsed = session.resumedAt
      ? Math.floor((now.getTime() - session.resumedAt.getTime()) / 1000)
      : 0;
    const newTotal = session.totalSeconds + elapsed;

    const updated = await this.prisma.taskSession.update({
      where: { id: sessionId },
      data: {
        status: 'paused',
        pausedAt: now,
        totalSeconds: newTotal,
      },
      include: SESSION_INCLUDE,
    });

    this.logger.info({ userId, sessionId, totalSeconds: newTotal }, 'Sessão de task pausada');

    const companyIdPause = updated.task.project.workspace.companyId;
    const payload: TaskSessionPausedPayload = {
      sessionId,
      taskId: session.taskId,
      projectId: updated.task.project.id,
      workspaceId: updated.task.project.workspaceId,
      companyId: companyIdPause,
      userId,
      totalSeconds: newTotal,
      status: 'paused',
    };

    this.gateway.emitToProject(updated.task.project.id, 'taskSession:paused', payload);
    this.gateway.emitToWorkspace(updated.task.project.workspaceId, 'taskSession:paused', payload);
    this.gateway.emitToCompany(companyIdPause, 'taskSession:paused', payload);

    return updated;
  }

  async resume(userId: string, sessionId: string) {
    const session = await this.findOwnedSession(userId, sessionId);

    if (session.status !== 'paused') {
      throw new BadRequestException('Sessão não está pausada');
    }

    const now = new Date();
    const updated = await this.prisma.taskSession.update({
      where: { id: sessionId },
      data: {
        status: 'running',
        pausedAt: null,
        resumedAt: now,
      },
      include: SESSION_INCLUDE,
    });

    this.logger.info({ userId, sessionId }, 'Sessão de task retomada');

    const companyIdResume = updated.task.project.workspace.companyId;
    const payload: TaskSessionResumedPayload = {
      sessionId,
      taskId: session.taskId,
      projectId: updated.task.project.id,
      workspaceId: updated.task.project.workspaceId,
      companyId: companyIdResume,
      userId,
      resumedAt: now.toISOString(),
      status: 'running',
    };

    this.gateway.emitToProject(updated.task.project.id, 'taskSession:resumed', payload);
    this.gateway.emitToWorkspace(updated.task.project.workspaceId, 'taskSession:resumed', payload);
    this.gateway.emitToCompany(companyIdResume, 'taskSession:resumed', payload);

    return updated;
  }

  async stop(userId: string, sessionId: string) {
    const session = await this.findOwnedSession(userId, sessionId);

    if (session.status === 'stopped') {
      throw new BadRequestException('Sessão já foi encerrada');
    }

    const now = new Date();
    let elapsed = 0;
    if (session.status === 'running' && session.resumedAt) {
      elapsed = Math.floor((now.getTime() - session.resumedAt.getTime()) / 1000);
    }
    const newTotal = session.totalSeconds + elapsed;

    const updated = await this.prisma.taskSession.update({
      where: { id: sessionId },
      data: {
        status: 'stopped',
        stoppedAt: now,
        totalSeconds: newTotal,
      },
      include: SESSION_INCLUDE,
    });

    this.logger.info({ userId, sessionId, totalSeconds: newTotal }, 'Sessão de task encerrada');

    const companyIdStop = updated.task.project.workspace.companyId;
    const payload: TaskSessionStoppedPayload = {
      sessionId,
      taskId: session.taskId,
      projectId: updated.task.project.id,
      workspaceId: updated.task.project.workspaceId,
      companyId: companyIdStop,
      userId,
      totalSeconds: newTotal,
      status: 'stopped',
    };

    this.gateway.emitToProject(updated.task.project.id, 'taskSession:stopped', payload);
    this.gateway.emitToWorkspace(updated.task.project.workspaceId, 'taskSession:stopped', payload);
    this.gateway.emitToCompany(companyIdStop, 'taskSession:stopped', payload);

    return updated;
  }

  async getMyActive(userId: string) {
    return this.prisma.taskSession.findMany({
      where: { userId, status: { in: ['running', 'paused'] } },
      include: SESSION_INCLUDE,
      orderBy: { startedAt: 'asc' },
    });
  }

  async getWorkspaceActive(workspaceId: string, requestingUserId: string) {
    // Verify admin access
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { companyId: true },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado');
    }

    const [wsAdmin, companyAdmin] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId: requestingUserId,
          resourceType: 'workspace',
          resourceId: workspaceId,
          role: 'workspace_admin',
          deletedAt: null,
        },
        select: { id: true },
      }),
      this.prisma.membership.findFirst({
        where: {
          userId: requestingUserId,
          resourceType: 'company',
          resourceId: workspace.companyId,
          role: 'admin',
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    if (!wsAdmin && !companyAdmin) {
      throw new ForbiddenException('Acesso restrito a administradores do workspace');
    }

    return this.prisma.taskSession.findMany({
      where: {
        status: { in: ['running', 'paused'] },
        task: {
          deletedAt: null,
          project: { workspaceId, deletedAt: null },
        },
      },
      include: SESSION_INCLUDE,
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
    });
  }

  async getCompanyActive(companyId: string, requestingUserId: string) {
    // Verify company admin access
    const isAdmin = await this.prisma.membership.findFirst({
      where: {
        userId: requestingUserId,
        resourceType: 'company',
        resourceId: companyId,
        role: 'admin',
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!isAdmin) {
      throw new ForbiddenException('Acesso restrito a administradores da empresa');
    }

    return this.prisma.taskSession.findMany({
      where: {
        status: { in: ['running', 'paused'] },
        task: {
          deletedAt: null,
          project: {
            deletedAt: null,
            workspace: { companyId, deletedAt: null },
          },
        },
      },
      include: SESSION_INCLUDE,
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
    });
  }

  private async findOwnedSession(userId: string, sessionId: string) {
    const session = await this.prisma.taskSession.findFirst({
      where: { id: sessionId },
      include: { task: { select: { ...TASK_SELECT } } },
    });

    if (!session) {
      throw new NotFoundException('Sessão não encontrada');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('Acesso negado a esta sessão');
    }

    return session;
  }
}
