import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import type { AuthUser, JwtPayload } from '../../auth/strategies/jwt.strategy';

@Injectable()
export class WsAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();

    const token: string | undefined =
      (client.handshake?.auth as Record<string, string> | undefined)?.token ??
      client.handshake?.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      client.disconnect();
      return false;
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });

      const user: AuthUser = {
        id: payload.sub,
        email: payload.email,
        isSuperuser: payload.isSuperuser,
        mustResetPassword: payload.mustResetPassword,
      };

      (client.data as { user: AuthUser }).user = user;
      return true;
    } catch {
      client.disconnect();
      return false;
    }
  }
}
