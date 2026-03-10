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
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { ProjetoAdminGuard } from './guards/projeto-admin.guard';
import { ProjetoMemberGuard } from './guards/projeto-member.guard';
import { ProjetoService } from './projeto.service';
import { CreateColunaDto } from './dto/create-coluna.dto';
import { UpdateColunaDto } from './dto/update-coluna.dto';
import { ReorderColunasDto } from './dto/reorder-colunas.dto';
import { DeleteColunaDto } from './dto/delete-coluna.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';
import { AssignTaskDto } from './dto/assign-task.dto';

@ApiTags('projetos')
@ApiBearerAuth()
@UseGuards(ProjetoMemberGuard)
@Controller('projetos/:projectId')
export class ProjetoController {
  constructor(private readonly projetoService: ProjetoService) {}

  // ── Kanban ────────────────────────────────────────────────────────────────────

  @Get('kanban')
  @ApiOperation({ summary: 'Retorna colunas e tasks do projeto (Kanban)' })
  @ApiResponse({ status: 200, description: 'Kanban retornado com sucesso' })
  @ApiResponse({ status: 404, description: 'Projeto não encontrado' })
  getKanban(@Param('projectId') projectId: string) {
    return this.projetoService.getKanban(projectId);
  }

  @Get('membros')
  @ApiOperation({ summary: 'Listar membros do workspace para seleção de responsável' })
  @ApiResponse({ status: 200, description: 'Lista de membros ativos' })
  listMembers(@Param('projectId') projectId: string) {
    return this.projetoService.listMembers(projectId);
  }

  // ── Colunas ───────────────────────────────────────────────────────────────────

  @Post('colunas')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar nova coluna no projeto' })
  @ApiResponse({ status: 201, description: 'Coluna criada' })
  createColuna(
    @Param('projectId') projectId: string,
    @Body() dto: CreateColunaDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.createColuna(projectId, dto, user.id);
  }

  @Patch('colunas/reorder')
  @UseGuards(ProjetoAdminGuard)
  @ApiOperation({ summary: 'Reordenar colunas do projeto' })
  @ApiResponse({ status: 200, description: 'Colunas reordenadas' })
  reorderColunas(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderColunasDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.reorderColunas(projectId, dto, user.id);
  }

  @Patch('colunas/:columnId')
  @UseGuards(ProjetoAdminGuard)
  @ApiOperation({ summary: 'Editar nome ou cor de uma coluna' })
  @ApiResponse({ status: 200, description: 'Coluna atualizada' })
  @ApiResponse({ status: 404, description: 'Coluna não encontrada' })
  updateColuna(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Body() dto: UpdateColunaDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.updateColuna(projectId, columnId, dto, user.id);
  }

  @Delete('colunas/:columnId')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de coluna (migra tasks se necessário)' })
  @ApiResponse({ status: 204, description: 'Coluna removida' })
  @ApiResponse({ status: 400, description: 'Coluna tem tasks e sem coluna de destino' })
  @ApiResponse({ status: 404, description: 'Coluna não encontrada' })
  async deleteColuna(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Body() dto: DeleteColunaDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.projetoService.deleteColuna(projectId, columnId, dto, user.id);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────────

  @Post('tasks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar task no projeto' })
  @ApiResponse({ status: 201, description: 'Task criada' })
  createTask(
    @Param('projectId') projectId: string,
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.createTask(projectId, dto, user.id);
  }

  @Patch('tasks/:taskId')
  @ApiOperation({ summary: 'Editar task' })
  @ApiResponse({ status: 200, description: 'Task atualizada' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  updateTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.updateTask(projectId, taskId, dto, user.id);
  }

  @Patch('tasks/:taskId/move')
  @ApiOperation({ summary: 'Mover task para outra coluna ou reordenar' })
  @ApiResponse({ status: 200, description: 'Task movida' })
  @ApiResponse({ status: 404, description: 'Task ou coluna não encontrada' })
  moveTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: MoveTaskDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.projetoService.moveTask(projectId, taskId, dto, user.id);
  }

  @Delete('tasks/:taskId')
  @UseGuards(ProjetoAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de task' })
  @ApiResponse({ status: 204, description: 'Task removida' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  async deleteTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.projetoService.deleteTask(projectId, taskId, user.id);
  }

  @Patch('tasks/:taskId/assign')
  @ApiOperation({ summary: 'Atribuir ou remover responsável da task' })
  @ApiResponse({ status: 200, description: 'Responsável atualizado' })
  @ApiResponse({ status: 404, description: 'Task não encontrada' })
  assignTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser() user: AuthUser,
    @Request() req: { projectMemberRole?: string },
  ) {
    return this.projetoService.assignTask(projectId, taskId, dto, user.id);
  }
}
