import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from '../../auth/strategies/jwt.strategy';

@Injectable()
export class SuperuserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user: AuthUser }>();
    if (!request.user?.isSuperuser) {
      throw new ForbiddenException('Acesso restrito a superusuários');
    }
    return true;
  }
}
