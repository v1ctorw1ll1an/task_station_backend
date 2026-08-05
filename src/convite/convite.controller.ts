import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { ConviteService } from './convite.service';

/**
 * Aceite de convite — fora de `/empresa/:companyId` de propósito: quem aceita ainda
 * NÃO é membro da empresa, então não passaria pelo `CompanyAdminGuard`.
 */
@ApiTags('convites')
@Controller('convites')
export class ConviteController {
  constructor(private readonly conviteService: ConviteService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  @ApiOperation({ summary: 'Consultar um convite pelo token (sem consumir)' })
  @ApiResponse({ status: 200, description: 'Situação do convite + nome da empresa' })
  preview(@Param('token') token: string) {
    return this.conviteService.preview(token);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/aceitar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceitar convite e entrar na empresa' })
  @ApiResponse({ status: 200, description: 'Entrou na empresa' })
  @ApiResponse({ status: 400, description: 'Convite inválido, expirado, cancelado ou já usado' })
  @ApiResponse({ status: 403, description: 'Convite é de outro e-mail ou empresa suspensa' })
  aceitar(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    return this.conviteService.aceitar(token, { id: user.id, email: user.email });
  }
}
