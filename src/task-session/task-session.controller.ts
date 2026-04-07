import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { TaskSessionService } from './task-session.service';
import { StartSessionDto } from './dto/start-session.dto';

@ApiTags('task-sessions')
@ApiBearerAuth()
@Controller('task-sessions')
export class TaskSessionController {
  constructor(private readonly service: TaskSessionService) {}

  @Post()
  @ApiOperation({ summary: 'Inicia uma sessão de tempo para uma task' })
  start(@CurrentUser() user: AuthUser, @Body() dto: StartSessionDto) {
    return this.service.start(user.id, dto.taskId);
  }

  @Patch(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pausa a sessão em execução' })
  pause(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.pause(user.id, id);
  }

  @Patch(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retoma a sessão pausada' })
  resume(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.resume(user.id, id);
  }

  @Patch(':id/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Encerra a sessão' })
  stop(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.stop(user.id, id);
  }

  @Get('mine/active')
  @ApiOperation({ summary: 'Retorna as sessões ativas do usuário autenticado' })
  getMyActive(@CurrentUser() user: AuthUser) {
    return this.service.getMyActive(user.id);
  }
}

@ApiTags('workspace')
@ApiBearerAuth()
@Controller('workspace/:workspaceId/task-sessions')
export class WorkspaceTaskSessionController {
  constructor(private readonly service: TaskSessionService) {}

  @Get('active')
  @ApiOperation({ summary: 'Retorna todas as sessões ativas do workspace (admin)' })
  getActive(@CurrentUser() user: AuthUser, @Param('workspaceId') workspaceId: string) {
    return this.service.getWorkspaceActive(workspaceId, user.id);
  }
}

@ApiTags('empresa')
@ApiBearerAuth()
@Controller('empresa/:companyId/task-sessions')
export class CompanyTaskSessionController {
  constructor(private readonly service: TaskSessionService) {}

  @Get('active')
  @ApiOperation({ summary: 'Retorna todas as sessões ativas da empresa (admin)' })
  getActive(@CurrentUser() user: AuthUser, @Param('companyId') companyId: string) {
    return this.service.getCompanyActive(companyId, user.id);
  }
}
