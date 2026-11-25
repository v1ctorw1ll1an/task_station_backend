import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { SuperuserGuard } from '../superadmin/guards/superuser.guard';
import type { ApiTokenContext } from './api-token.constants';
import { ApiTokenService } from './api-token.service';
import { AllowApiToken } from './decorators/allow-api-token.decorator';
import { CreateApiTokenDto } from './dto/create-api-token.dto';

/**
 * Gestão dos tokens de acesso pessoal. Criar, listar e revogar exigem a sessão do
 * navegador (JWT): sem `@AllowApiToken`, um token não cria outro token nem se
 * estende. Só `current` responde ao próprio token.
 *
 * A integração é **só de superusuário**: as rotas de gestão levam `SuperuserGuard`.
 * `current` não leva — quem chama é o próprio token, que por regra nunca carrega poder
 * de superusuário; lá a trava é o `authenticate`, que recusa token de dono rebaixado.
 */
@ApiTags('api-tokens')
@ApiBearerAuth()
@Controller('me/api-tokens')
export class ApiTokenController {
  constructor(private readonly apiTokenService: ApiTokenService) {}

  @Get()
  @UseGuards(SuperuserGuard)
  @ApiOperation({ summary: 'Listar meus tokens de acesso (sem os revogados)' })
  @ApiResponse({ status: 200, description: 'Lista de tokens' })
  list(@CurrentUser() user: AuthUser) {
    return this.apiTokenService.list(user.id);
  }

  @Get('workspaces')
  @UseGuards(SuperuserGuard)
  @ApiOperation({ summary: 'Workspaces onde posso criar token de acesso' })
  @ApiResponse({ status: 200, description: 'Lista de workspaces elegíveis' })
  listWorkspaces(@CurrentUser() user: AuthUser) {
    return this.apiTokenService.listEligibleWorkspaces(user.id);
  }

  @Post()
  @UseGuards(SuperuserGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar token de acesso restrito a um workspace' })
  @ApiResponse({ status: 201, description: 'Token criado — o valor em claro só aparece aqui' })
  @ApiResponse({ status: 400, description: 'Limite de tokens ativos atingido' })
  @ApiResponse({
    status: 403,
    description: 'Não é superusuário, ou não é membro do workspace',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApiTokenDto) {
    return this.apiTokenService.create(user.id, dto);
  }

  @Get('current')
  @AllowApiToken()
  @ApiOperation({ summary: 'Dados do token usado nesta request (workspace e usuário)' })
  @ApiResponse({ status: 200, description: 'Escopo do token' })
  @ApiResponse({ status: 400, description: 'Request não foi feita com token de acesso' })
  current(@Request() req: { user: AuthUser; apiToken?: ApiTokenContext }) {
    if (!req.apiToken) {
      throw new BadRequestException('Esta rota só responde a tokens de acesso');
    }
    return this.apiTokenService.describeCurrent(req.apiToken, req.user);
  }

  @Delete(':id')
  @UseGuards(SuperuserGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revogar token de acesso' })
  @ApiResponse({ status: 204, description: 'Token revogado' })
  @ApiResponse({ status: 404, description: 'Token não encontrado' })
  async revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.apiTokenService.revoke(user.id, id);
  }
}
