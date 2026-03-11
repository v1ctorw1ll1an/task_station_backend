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
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { WorkspaceAdminGuard } from './guards/workspace-admin.guard';
import { WorkspaceCompanyAdminGuard } from './guards/workspace-company-admin.guard';
import { WorkspaceMemberGuard } from './guards/workspace-member.guard';
import { WorkspaceService } from './workspace.service';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { ListWorkspaceMembersQueryDto } from './dto/list-workspace-members-query.dto';
import { PromoteWorkspaceAdminDto } from './dto/promote-workspace-admin.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@ApiTags('workspace')
@ApiBearerAuth()
@Controller('workspace/:workspaceId')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  // ── Workspace info ────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(WorkspaceMemberGuard)
  @ApiOperation({ summary: 'Informações básicas do workspace (id, companyId, isActive)' })
  @ApiResponse({ status: 200, description: 'Workspace encontrado' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  getInfo(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.getInfo(workspaceId);
  }

  // ── Projetos ──────────────────────────────────────────────────────────────────

  @Post('projetos')
  @UseGuards(WorkspaceAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar projeto com colunas Kanban padrão' })
  @ApiResponse({ status: 201, description: 'Projeto criado com sucesso' })
  createProject(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.workspaceService.createProject(workspaceId, dto, user.id);
  }

  @Get('projetos')
  @UseGuards(WorkspaceMemberGuard)
  @ApiOperation({ summary: 'Listar projetos do workspace com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de projetos' })
  listProjects(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListProjectsQueryDto,
    @Request() req: { workspaceMemberRole?: string; user: AuthUser },
  ) {
    const isAdmin = req.workspaceMemberRole === 'workspace_admin';
    return this.workspaceService.listProjects(workspaceId, query, isAdmin, req.user.id);
  }

  @Get('projetos/:projectId')
  @UseGuards(WorkspaceMemberGuard)
  @ApiOperation({ summary: 'Detalhes de um projeto' })
  @ApiResponse({ status: 200, description: 'Projeto encontrado' })
  @ApiResponse({ status: 404, description: 'Projeto não encontrado' })
  getProject(@Param('workspaceId') workspaceId: string, @Param('projectId') projectId: string) {
    return this.workspaceService.getProject(workspaceId, projectId);
  }

  @Patch('projetos/:projectId')
  @UseGuards(WorkspaceAdminGuard)
  @ApiOperation({ summary: 'Editar nome ou descrição do projeto' })
  @ApiResponse({ status: 200, description: 'Projeto atualizado' })
  @ApiResponse({ status: 404, description: 'Projeto não encontrado' })
  updateProject(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.workspaceService.updateProject(workspaceId, projectId, dto);
  }

  @Patch('projetos/:projectId/inativar')
  @UseGuards(WorkspaceAdminGuard)
  @ApiOperation({ summary: 'Inativar projeto' })
  @ApiResponse({ status: 200, description: 'Projeto inativado' })
  @ApiResponse({ status: 404, description: 'Projeto não encontrado' })
  deactivateProject(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.workspaceService.deactivateProject(workspaceId, projectId);
  }

  @Patch('projetos/:projectId/ativar')
  @UseGuards(WorkspaceAdminGuard)
  @ApiOperation({ summary: 'Reativar projeto' })
  @ApiResponse({ status: 200, description: 'Projeto reativado' })
  @ApiResponse({ status: 404, description: 'Projeto não encontrado' })
  activateProject(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.workspaceService.activateProject(workspaceId, projectId);
  }

  @Delete('projetos/:projectId')
  @UseGuards(WorkspaceAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de projeto (colunas e tasks incluídas)' })
  @ApiResponse({ status: 204, description: 'Projeto removido' })
  @ApiResponse({ status: 404, description: 'Projeto não encontrado' })
  async deleteProject(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.workspaceService.deleteProject(workspaceId, projectId, user.id);
  }

  // ── Membros ───────────────────────────────────────────────────────────────────

  @Get('membros')
  @UseGuards(WorkspaceAdminGuard)
  @ApiOperation({ summary: 'Listar membros do workspace com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de membros' })
  listMembers(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListWorkspaceMembersQueryDto,
  ) {
    return this.workspaceService.listMembers(workspaceId, query);
  }

  @Post('membros')
  @UseGuards(WorkspaceCompanyAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Adicionar membro ao workspace (somente gerente da empresa)' })
  @ApiResponse({ status: 201, description: 'Membro adicionado' })
  @ApiResponse({ status: 409, description: 'Usuário já é membro deste workspace' })
  addMember(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: AddWorkspaceMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.workspaceService.addMember(workspaceId, dto, user.id);
  }

  @Delete('membros/:userId')
  @UseGuards(WorkspaceCompanyAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover membro do workspace (somente gerente da empresa)' })
  @ApiResponse({ status: 204, description: 'Membro removido' })
  @ApiResponse({ status: 400, description: 'Não é possível remover a si mesmo' })
  @ApiResponse({ status: 403, description: 'Revogue o papel de admin antes de remover' })
  @ApiResponse({ status: 404, description: 'Membro não encontrado' })
  async removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.workspaceService.removeMember(workspaceId, userId, user.id);
  }

  // ── Admins ────────────────────────────────────────────────────────────────────

  @Post('admins')
  @UseGuards(WorkspaceCompanyAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Promover membro a workspace_admin (somente gerente da empresa)' })
  @ApiResponse({ status: 201, description: 'Membro promovido a admin' })
  @ApiResponse({ status: 404, description: 'Usuário não é membro deste workspace' })
  @ApiResponse({ status: 409, description: 'Usuário já é administrador' })
  promoteToAdmin(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: PromoteWorkspaceAdminDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.workspaceService.promoteToAdmin(workspaceId, dto, user.id);
  }

  @Delete('admins/:userId')
  @UseGuards(WorkspaceCompanyAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revogar papel de workspace_admin (somente gerente da empresa)' })
  @ApiResponse({ status: 204, description: 'Papel de admin revogado' })
  @ApiResponse({ status: 400, description: 'Não pode revogar o único admin ou o próprio papel' })
  @ApiResponse({ status: 404, description: 'Admin não encontrado' })
  async revokeAdmin(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.workspaceService.revokeAdmin(workspaceId, userId, user.id);
  }
}
