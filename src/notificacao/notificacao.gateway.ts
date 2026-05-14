import { UseGuards } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { WsAuthGuard } from '../common/guards/ws-auth.guard';
import { MetricsService } from '../metrics/metrics.service';
import type { AuthUser } from '../auth/strategies/jwt.strategy';

const NAMESPACE = 'notifications';

@WebSocketGateway({
  namespace: '/notifications',
  cors: { origin: process.env.FRONTEND_URL ?? 'http://localhost:3001', credentials: true },
})
export class NotificacaoGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(
    @InjectPinoLogger(NotificacaoGateway.name) private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {}

  handleConnection(client: Socket) {
    this.metrics.wsConnect(NAMESPACE);
    this.logger.debug({ socketId: client.id }, 'Cliente conectado ao NotificacaoGateway');
  }

  handleDisconnect(client: Socket) {
    this.metrics.wsDisconnect(NAMESPACE);
    this.logger.debug({ socketId: client.id }, 'Cliente desconectado do NotificacaoGateway');
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('subscribeNotifications')
  handleSubscribe(client: Socket): void {
    const user = (client.data as { user: AuthUser }).user;
    void client.join(`user:${user.id}`);
    client.emit('subscribedNotifications', { ok: true });
    this.logger.debug({ userId: user.id }, 'Usuário inscrito em notificações');
  }

  emitToUser<T>(userId: string, event: string, data: T): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }
}
