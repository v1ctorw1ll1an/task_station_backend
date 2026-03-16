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
import { WsAuthGuard } from './guards/ws-auth.guard';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { KanbanEvent } from './kanban-events.types';

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
  ) {}

  afterInit() {
    this.logger.info('KanbanGateway inicializado');
  }

  handleConnection(client: Socket) {
    this.logger.debug({ socketId: client.id }, 'Cliente conectado ao KanbanGateway');
  }

  handleDisconnect(client: Socket) {
    this.logger.debug({ socketId: client.id }, 'Cliente desconectado do KanbanGateway');
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
