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
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { ProjetoMemberGuard } from '../projeto/guards/projeto-member.guard';
import { CreateGuestDto } from './dto/create-guest.dto';
import { NotifyGuestDto } from './dto/notify-guest.dto';
import { ToggleGuestLinkDto } from './dto/toggle-guest-link.dto';
import { TaskGuestService } from './task-guest.service';

function isProjectAdmin(role?: string): boolean {
  return role === 'workspace_admin' || role === 'project_admin';
}

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
  list(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthUser,
    @Request() req: { projectMemberRole?: string },
  ) {
    return this.service.listGuests(taskId, user.id, isProjectAdmin(req.projectMemberRole));
  }

  @Get('search')
  @ApiOperation({
    summary: 'Busca convidados únicos do workspace (por nome/telefone/email) para reuso',
  })
  search(@Param('projectId') projectId: string, @Query('q', new DefaultValuePipe('')) q: string) {
    return this.service.searchGuests(projectId, q);
  }

  @Post('notify/preview')
  @ApiOperation({
    summary: 'Retorna o resumo (texto editável) das mudanças, sem saudação/link',
  })
  @ApiResponse({ status: 200, description: 'Resumo gerado' })
  @ApiResponse({ status: 400, description: 'Nenhuma alteração válida' })
  previewNotify(@Param('taskId') taskId: string, @Body() dto: NotifyGuestDto) {
    return this.service.previewGuestNotify(taskId, dto.historyEntryIds);
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
    return this.service.buildGuestNotifyUrl(taskId, guestId, dto.historyEntryIds, dto.message);
  }

  @Patch(':guestId/extend')
  @ApiOperation({ summary: 'Estende a expiração do link público (padrão: +30 dias)' })
  @ApiResponse({ status: 200, description: 'Expiração atualizada' })
  @ApiResponse({ status: 404, description: 'Convidado não encontrado' })
  extend(@Param('guestId') guestId: string, @Query('days', new DefaultValuePipe(30)) days: number) {
    return this.service.extendGuest(guestId, Number(days));
  }

  @Patch(':guestId/link')
  @ApiOperation({ summary: 'Habilita/desabilita o link público do convidado (owner ou admin)' })
  @ApiResponse({ status: 200, description: 'Estado do link atualizado' })
  @ApiResponse({ status: 403, description: 'Sem permissão para gerenciar o link' })
  @ApiResponse({ status: 404, description: 'Convidado não encontrado nesta task' })
  toggleLink(
    @Param('taskId') taskId: string,
    @Param('guestId') guestId: string,
    @Body() dto: ToggleGuestLinkDto,
    @CurrentUser() user: AuthUser,
    @Request() req: { projectMemberRole?: string },
  ) {
    return this.service.setGuestLinkEnabled(
      taskId,
      guestId,
      dto.enabled,
      user.id,
      isProjectAdmin(req.projectMemberRole),
    );
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
