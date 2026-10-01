import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { CalendarSyncEnqueuer } from './calendar-sync.enqueuer';
import { CompleteGoogleConnectDto, UpdateGoogleSourcesDto } from './dto/google-calendar.dto';
import { GoogleCalendarConnectionService } from './google-calendar-connection.service';

/**
 * Integração do usuário logado com o Google Agenda. O callback do OAuth mora no
 * front (tem a sessão) e chega aqui autenticado em `POST callback` — é isso que
 * amarra o `state` ao usuário certo.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/google')
export class GoogleCalendarController {
  constructor(
    private readonly connections: GoogleCalendarConnectionService,
    private readonly enqueuer: CalendarSyncEnqueuer,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Status da conexão, calendários e empresas elegíveis' })
  status(@CurrentUser() user: AuthUser) {
    return this.connections.getStatus(user.id, user.email);
  }

  @Get('connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'URL de consentimento do Google (state assinado, 10 min)' })
  connect(@CurrentUser() user: AuthUser) {
    return this.connections.buildConnectUrl(user.id, user.email);
  }

  @Post('callback')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Conclui o OAuth: troca o code e dispara o backfill' })
  callback(@CurrentUser() user: AuthUser, @Body() dto: CompleteGoogleConnectDto) {
    return this.connections.completeConnect(user.id, user.email, dto.code, dto.state);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  // Chama o Google (parar canais + revogar token).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Desconecta: revoga o acesso e para de sincronizar (nada é apagado)' })
  async disconnect(@CurrentUser() user: AuthUser) {
    await this.connections.disconnect(user.id);
  }

  @Patch('sources')
  // Cada ligar/desligar abre ou fecha canal no Google.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Liga/desliga a importação de calendários do Google' })
  async updateSources(@CurrentUser() user: AuthUser, @Body() dto: UpdateGoogleSourcesDto) {
    await this.connections.updateSources(user.id, dto.sources);
    return this.connections.getStatus(user.id, user.email);
  }

  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Agenda uma sincronização completa agora' })
  async syncNow(@CurrentUser() user: AuthUser) {
    const status = await this.connections.getStatus(user.id, user.email);
    if (status.connection?.status === 'active') {
      await this.enqueuer.enqueue(user.id, 'full_resync');
    }
    return { queued: status.connection?.status === 'active' };
  }
}
