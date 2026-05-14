import { UseGuards } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { WsAuthGuard } from './guards/ws-auth.guard';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { KanbanEvent } from './kanban-events.types';

const NAMESPACE = 'kanban';

@WebSocketGateway({
  namespace: '/kanban',
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    credentials: true,
  },
})
export class KanbanGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server: Server;

  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(KanbanGateway.name)
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {}

  afterInit() {
    this.logger.info('KanbanGateway inicializado');
  }

  handleConnection(client: Socket) {
    this.metrics.wsConnect(NAMESPACE);
    this.logger.debug({ socketId: client.id }, 'Cliente conectado ao KanbanGateway');
  }

  handleDisconnect(client: Socket) {
    this.metrics.wsDisconnect(NAMESPACE);
    this.logger.debug({ socketId: client.id }, 'Cliente desconectado do KanbanGateway');
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('joinCompany')
  async handleJoinCompany(client: Socket, payload: { companyId: string }): Promise<void> {
    const user = (client.data as { user: AuthUser }).user;

    if (!payload?.companyId) {
      client.emit('error', { message: 'companyId é obrigatório' });
      return;
    }

    const isAdmin = await this.prisma.membership.findFirst({
      where: {
        userId: user.id,
        resourceType: 'company',
        resourceId: payload.companyId,
        role: 'admin',
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!isAdmin) {
      client.emit('error', { message: 'Acesso negado à empresa' });
      return;
    }

    const room = `company:${payload.companyId}`;
    await client.join(room);
    client.emit('joinedCompany', { companyId: payload.companyId });

    this.logger.info(
      { userId: user.id, companyId: payload.companyId, room },
      'Cliente entrou na sala da empresa',
    );
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('joinWorkspace')
  async handleJoinWorkspace(client: Socket, payload: { workspaceId: string }): Promise<void> {
    const user = (client.data as { user: AuthUser }).user;

    if (!payload?.workspaceId) {
      client.emit('error', { message: 'workspaceId é obrigatório' });
      return;
    }

    const isMember = await this.validateWorkspaceMembership(user.id, payload.workspaceId);
    if (!isMember) {
      client.emit('error', { message: 'Acesso negado ao workspace' });
      return;
    }

    const room = `workspace:${payload.workspaceId}`;
    await client.join(room);
    client.emit('joinedWorkspace', { workspaceId: payload.workspaceId });

    this.logger.info(
      { userId: user.id, workspaceId: payload.workspaceId, room },
      'Cliente entrou na sala do workspace',
    );
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('joinProject')
  async handleJoinProject(client: Socket, payload: { projectId: string }): Promise<void> {
    const user = (client.data as { user: AuthUser }).user;

    if (!payload?.projectId) {
      client.emit('error', { message: 'projectId é obrigatório' });
      return;
    }

    const isMember = await this.validateMembership(user.id, payload.projectId);
    if (!isMember) {
      client.emit('error', { message: 'Acesso negado ao projeto' });
      return;
    }

    const room = `project:${payload.projectId}`;
    await client.join(room);
    client.emit('joinedProject', { projectId: payload.projectId });

    this.logger.info(
      { userId: user.id, projectId: payload.projectId, room },
      'Cliente entrou na sala do projeto',
    );
  }

  /**
   * Emite um evento para todos os clientes conectados à sala do projeto.
   * Chamado diretamente pelo ProjetoService após cada mutação bem-sucedida.
   */
  emitToProject<T>(projectId: string, event: KanbanEvent, data: T): void {
    const room = `project:${projectId}`;
    this.server.to(room).emit(event, data);
    this.logger.debug({ projectId, event }, 'Evento emitido para sala do projeto');
  }

  emitToWorkspace<T>(workspaceId: string, event: KanbanEvent, data: T): void {
    const room = `workspace:${workspaceId}`;
    this.server.to(room).emit(event, data);
    this.logger.debug({ workspaceId, event }, 'Evento emitido para sala do workspace');
  }

  emitToCompany<T>(companyId: string, event: KanbanEvent, data: T): void {
    const room = `company:${companyId}`;
    this.server.to(room).emit(event, data);
    this.logger.debug({ companyId, event }, 'Evento emitido para sala da empresa');
  }

  private async validateWorkspaceMembership(userId: string, workspaceId: string): Promise<boolean> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { companyId: true },
    });

    if (!workspace) return false;

    const [workspaceMembership, companyAdmin] = await Promise.all([
      this.prisma.membership.findFirst({
        where: { userId, resourceType: 'workspace', resourceId: workspaceId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.membership.findFirst({
        where: {
          userId,
          resourceType: 'company',
          resourceId: workspace.companyId,
          role: 'admin',
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    return !!(workspaceMembership || companyAdmin);
  }

  private async validateMembership(userId: string, projectId: string): Promise<boolean> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        workspaceId: true,
        workspace: { select: { companyId: true } },
      },
    });

    if (!project) return false;

    const [workspaceMembership, companyAdmin] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId,
          resourceType: 'workspace',
          resourceId: project.workspaceId,
          deletedAt: null,
        },
        select: { id: true },
      }),
      this.prisma.membership.findFirst({
        where: {
          userId,
          resourceType: 'company',
          resourceId: project.workspace.companyId,
          role: 'admin',
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    return !!(workspaceMembership || companyAdmin);
  }
}
