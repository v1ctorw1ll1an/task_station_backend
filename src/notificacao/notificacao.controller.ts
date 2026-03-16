import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { NotificacaoService } from './notificacao.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { UpdatePreferenceDto } from './dto/update-preference.dto';

@ApiTags('notificacoes')
@Controller('me/notificacoes')
export class NotificacaoController {
  constructor(private readonly notificacaoService: NotificacaoService) {}

  @Get()
  @ApiOperation({ summary: 'Listar notificações do usuário logado' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListNotificationsQueryDto) {
    return this.notificacaoService.listForUser(
      user.id,
      query.page ?? 1,
      query.limit ?? 20,
      query.unreadOnly ?? false,
    );
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Contagem de notificações não lidas' })
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notificacaoService.countUnread(user.id);
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Marcar todas as notificações como lidas' })
  markAllAsRead(@CurrentUser() user: AuthUser) {
    return this.notificacaoService.markAllAsRead(user.id);
  }

  @Get('preferencias')
  @ApiOperation({ summary: 'Obter preferências de notificação' })
  getPreferences(@CurrentUser() user: AuthUser) {
    return this.notificacaoService.getPreference(user.id);
  }

  @Patch('preferencias')
  @ApiOperation({ summary: 'Atualizar preferências de notificação' })
  updatePreferences(@CurrentUser() user: AuthUser, @Body() dto: UpdatePreferenceDto) {
    return this.notificacaoService.updatePreference(user.id, dto);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Marcar uma notificação como lida' })
  markAsRead(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacaoService.markAsRead(id, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover uma notificação' })
  delete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificacaoService.deleteNotification(id, user.id);
  }
}
