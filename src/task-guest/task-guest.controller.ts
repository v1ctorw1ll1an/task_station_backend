import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { ProjetoMemberGuard } from '../projeto/guards/projeto-member.guard';
import { CreateGuestDto } from './dto/create-guest.dto';
import { NotifyGuestDto } from './dto/notify-guest.dto';
import { TaskGuestService } from './task-guest.service';

@ApiTags('task-guests')
@ApiBearerAuth()
@UseGuards(ProjetoMemberGuard)
@Controller('projetos/:projectId/tasks/:taskId/guests')
export class TaskGuestController {
  constructor(private readonly service: TaskGuestService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cria convidado externo para uma task e retorna link público + wa.me' })
  @ApiResponse({ status: 201, description: 'Convidado criado' })
  @ApiResponse({ status: 400, description: 'Telefone inválido ou limite atingido' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  @ApiResponse({ status: 429, description: 'Throttle atingido (10/min por usuário)' })
  create(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateGuestDto,
  ) {
    return this.service.createGuest(taskId, user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista convidados ativos de uma task' })
  list(@Param('taskId') taskId: string) {
    return this.service.listGuests(taskId);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Busca convidados únicos do workspace (por nome/telefone/email) para reuso',
  })
  search(@Param('projectId') projectId: string, @Query('q', new DefaultValuePipe('')) q: string) {
    return this.service.searchGuests(projectId, q);
  }

  @Post(':guestId/notify')
  @ApiOperation({
    summary: 'Constrói URL wa.me com relatório de mudanças para enviar ao convidado',
  })
  @ApiResponse({ status: 200, description: 'URL gerada' })
  @ApiResponse({ status: 400, description: 'Nenhuma alteração válida' })
  @ApiResponse({ status: 404, description: 'Convidado não encontrado nesta task' })
  notify(
    @Param('taskId') taskId: string,
    @Param('guestId') guestId: string,
    @Body() dto: NotifyGuestDto,
  ) {
    return this.service.buildGuestNotifyUrl(taskId, guestId, dto.historyEntryIds);
  }

  @Patch(':guestId/extend')
  @ApiOperation({ summary: 'Estende a expiração do link público (padrão: +30 dias)' })
  @ApiResponse({ status: 200, description: 'Expiração atualizada' })
  @ApiResponse({ status: 404, description: 'Convidado não encontrado' })
  extend(@Param('guestId') guestId: string, @Query('days', new DefaultValuePipe(30)) days: number) {
    return this.service.extendGuest(guestId, Number(days));
  }

  @Delete(':guestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoga acesso de um convidado (soft delete)' })
  @ApiResponse({ status: 204, description: 'Convidado revogado' })
  @ApiResponse({ status: 404, description: 'Convidado não encontrado nesta task' })
  async revoke(@Param('taskId') taskId: string, @Param('guestId') guestId: string) {
    await this.service.revokeGuest(taskId, guestId);
  }
}
