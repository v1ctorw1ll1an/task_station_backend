import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { CreateEventDto } from './dto/create-event.dto';
import { EventMutationScopeDto } from './dto/event-mutation-scope.dto';
import { InviteAttendeeDto } from './dto/invite-attendee.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { RsvpDto } from './dto/rsvp.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventoService } from './evento.service';

@ApiTags('calendar-events')
@ApiBearerAuth()
@Controller('me/calendar-events')
export class EventoController {
  constructor(private readonly service: EventoService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista ocorrências de eventos do usuário (próprios + onde é attendee) num intervalo',
  })
  @ApiResponse({ status: 200, description: 'Array de ocorrências expandidas' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListEventsQueryDto) {
    return this.service.listOccurrences(user.id, query);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Busca eventos por título e expande as próximas ocorrências (hoje → +12m)',
  })
  @ApiResponse({ status: 200, description: 'Array de ocorrências que casam com a busca' })
  search(
    @CurrentUser() user: AuthUser,
    @Query('q') q: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.service.searchOccurrences(user.id, q ?? '', companyId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria novo evento (com attendees e reminders inline)' })
  @ApiResponse({ status: 201, description: 'Evento criado' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEventDto) {
    return this.service.create(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe da série (não expande ocorrências)' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Atualiza evento. scope=single cria exception, scope=all atualiza a série',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @Query() scope: EventMutationScopeDto,
  ) {
    return this.service.update(user.id, id, dto, scope);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deleta evento. scope=single cancela só a ocorrência, scope=all soft-delete da série',
  })
  async delete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() scope: EventMutationScopeDto,
  ) {
    await this.service.delete(user.id, id, scope);
  }

  @Post(':id/attendees')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Convidar usuário para o evento' })
  invite(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: InviteAttendeeDto) {
    return this.service.inviteAttendee(user.id, id, dto.userId);
  }

  @Delete(':id/attendees/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove um attendee' })
  async removeAttendee(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') attendeeId: string,
  ) {
    await this.service.removeAttendee(user.id, id, attendeeId);
  }

  @Patch(':id/rsvp')
  @ApiOperation({ summary: 'RSVP do usuário logado (accepted/declined/tentative)' })
  rsvp(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RsvpDto) {
    return this.service.rsvp(user.id, id, dto.status);
  }
}
