import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthRepository } from '../auth.repository';

export interface JwtPayload {
  sub: string;
  email: string;
  isSuperuser: boolean;
  mustResetPassword: boolean;
  /** Sessão que emitiu este token — um assento, um login (ver `AuthService.login`). */
  sid?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  isSuperuser: boolean;
  mustResetPassword: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly repo: AuthRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Um assento = um login: além da assinatura do token, cada request confere se a
   * sessão ainda é **a** sessão do usuário. Entrar em outro PC/aba/navegador troca
   * o `activeSessionId` e derruba a anterior aqui. Também é o ponto onde um usuário
   * desativado/excluído perde acesso na hora, sem esperar o token expirar.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.repo.findActiveUserById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException({ code: 'USER_INACTIVE', message: 'Usuário sem acesso' });
    }
    // Tokens antigos (emitidos antes da sessão única) não carregam `sid`: valem até
    // expirar, mas qualquer login novo passa a valer como sessão única.
    if (payload.sid && user.activeSessionId && payload.sid !== user.activeSessionId) {
      throw new UnauthorizedException({
        code: 'SESSION_REPLACED',
        message: 'Sua sessão foi encerrada porque este usuário entrou em outro dispositivo.',
      });
    }

    return {
      id: user.id,
      email: user.email,
      isSuperuser: user.isSuperuser,
      mustResetPassword: user.mustResetPassword,
    };
  }
}
