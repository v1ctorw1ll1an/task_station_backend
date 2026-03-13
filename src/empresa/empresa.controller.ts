import {
  BadRequestException,
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { CompanyAdminGuard } from './guards/company-admin.guard';
import { EmpresaService } from './empresa.service';
import { ContratarMembroDto } from './dto/contratar-membro.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { ListWorkspacesQueryDto } from './dto/list-workspaces-query.dto';
import { PromoteMemberDto } from './dto/promote-member.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@ApiTags('empresa')
@ApiBearerAuth()
@UseGuards(CompanyAdminGuard)
@Controller('empresa/:companyId')
export class EmpresaController {
  constructor(private readonly empresaService: EmpresaService) {}

  // ── Workspaces ────────────────────────────────────────────────────────────────

  @Post('workspaces')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar workspace e admin inicial' })
  @ApiResponse({ status: 201, description: 'Workspace criado com sucesso' })
  @ApiResponse({ status: 409, description: 'Email já cadastrado fora desta empresa' })
  createWorkspace(
    @Param('companyId') companyId: string,
    @Body() dto: CreateWorkspaceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.createWorkspace(companyId, dto, user.id);
  }

  @Get('workspaces')
  @ApiOperation({ summary: 'Listar workspaces da empresa com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de workspaces' })
  listWorkspaces(@Param('companyId') companyId: string, @Query() query: ListWorkspacesQueryDto) {
    return this.empresaService.listWorkspaces(companyId, query);
  }

  @Get('workspaces/:workspaceId')
  @ApiOperation({ summary: 'Detalhes de um workspace' })
  @ApiResponse({ status: 200, description: 'Workspace encontrado' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  getWorkspace(@Param('companyId') companyId: string, @Param('workspaceId') workspaceId: string) {
    return this.empresaService.getWorkspace(companyId, workspaceId);
  }

  @Patch('workspaces/:workspaceId')
  @ApiOperation({ summary: 'Editar nome ou descrição do workspace' })
  @ApiResponse({ status: 200, description: 'Workspace atualizado' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  updateWorkspace(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.empresaService.updateWorkspace(companyId, workspaceId, dto);
  }

  @Patch('workspaces/:workspaceId/inativar')
  @ApiOperation({ summary: 'Inativar workspace' })
  @ApiResponse({ status: 200, description: 'Workspace inativado' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  deactivateWorkspace(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.empresaService.deactivateWorkspace(companyId, workspaceId);
  }

  @Patch('workspaces/:workspaceId/ativar')
  @ApiOperation({ summary: 'Reativar workspace' })
  @ApiResponse({ status: 200, description: 'Workspace reativado' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  activateWorkspace(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.empresaService.activateWorkspace(companyId, workspaceId);
  }

  @Delete('workspaces/:workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de workspace' })
  @ApiResponse({ status: 204, description: 'Workspace removido' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  async deleteWorkspace(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.empresaService.deleteWorkspace(companyId, workspaceId, user.id);
  }

  // ── Membros ───────────────────────────────────────────────────────────────────

  @Post('membros/contratar')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Contratar novo colaborador (cria conta + adiciona à empresa)' })
  @ApiResponse({ status: 201, description: 'Colaborador criado e adicionado à empresa' })
  @ApiResponse({ status: 409, description: 'Email já cadastrado no sistema' })
  contratarMembro(
    @Param('companyId') companyId: string,
    @Body() dto: ContratarMembroDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.contratarMembro(companyId, dto, user.id);
  }

  @Get('membros')
  @ApiOperation({ summary: 'Listar membros da empresa com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de membros' })
  listMembers(@Param('companyId') companyId: string, @Query() query: ListMembersQueryDto) {
    return this.empresaService.listMembers(companyId, query);
  }

  @Patch('membros/:userId')
  @ApiOperation({ summary: 'Inativar ou reativar membro da empresa' })
  @ApiResponse({ status: 200, description: 'Membro atualizado' })
  @ApiResponse({ status: 400, description: 'Não é possível alterar o próprio usuário' })
  @ApiResponse({ status: 404, description: 'Membro não encontrado' })
  updateMember(
    @Param('companyId') companyId: string,
    @Param('userId') userId: string,
    @Body() dto: { isActive?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.updateMember(companyId, userId, dto, user.id);
  }

  @Delete('membros/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover membro da empresa e de todos os seus workspaces' })
  @ApiResponse({ status: 204, description: 'Membro removido' })
  @ApiResponse({ status: 400, description: 'Não é possível remover a si mesmo' })
  @ApiResponse({ status: 404, description: 'Membro não encontrado' })
  async removeMember(
    @Param('companyId') companyId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.empresaService.removeMember(companyId, userId, user.id);
  }

  // ── Admins ────────────────────────────────────────────────────────────────────

  @Post('admins')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Promover membro a administrador da empresa' })
  @ApiResponse({ status: 201, description: 'Membro promovido a admin' })
  @ApiResponse({ status: 404, description: 'Usuário não é membro desta empresa' })
  @ApiResponse({ status: 409, description: 'Usuário já é administrador' })
  promoteToAdmin(
    @Param('companyId') companyId: string,
    @Body() dto: PromoteMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.promoteToAdmin(companyId, dto, user.id);
  }

  @Delete('admins/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revogar papel de administrador da empresa' })
  @ApiResponse({ status: 204, description: 'Papel de admin revogado' })
  @ApiResponse({ status: 400, description: 'Não pode revogar o único admin ou o próprio papel' })
  @ApiResponse({ status: 404, description: 'Admin não encontrado' })
  async revokeAdmin(
    @Param('companyId') companyId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.empresaService.revokeAdmin(companyId, userId, user.id);
  }

  // ── Papéis por membro ─────────────────────────────────────────────────────────

  @Get('membros/:userId/papeis')
  @ApiOperation({ summary: 'Listar todos os papéis de um membro (empresa + workspaces)' })
  @ApiResponse({ status: 200, description: 'Papéis do membro' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  getMemberRoles(@Param('companyId') companyId: string, @Param('userId') userId: string) {
    return this.empresaService.getMemberRoles(companyId, userId);
  }

  @Patch('workspaces/:workspaceId/membros/:userId/role')
  @ApiOperation({
    summary:
      'Definir papel do membro no workspace (dropdown: workspace_admin | project_admin | member | null=sem acesso)',
  })
  @ApiResponse({ status: 200, description: 'Papel atualizado' })
  setWorkspaceMemberRole(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() dto: { role: 'workspace_admin' | 'project_admin' | 'member' | null },
    @CurrentUser() user: AuthUser,
  ) {
    const allowed = ['workspace_admin', 'project_admin', 'member', null];
    if (!allowed.includes(dto.role)) {
      throw new BadRequestException('Role inválido');
    }
    return this.empresaService.setWorkspaceMemberRole(
      companyId,
      workspaceId,
      userId,
      dto.role,
      user.id,
    );
  }

  @Post('workspaces/:workspaceId/projetos/:projectId/restrict')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Restringir acesso de um usuário a um projeto específico' })
  @ApiResponse({ status: 201, description: 'Restrição criada' })
  restrictProject(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Body() dto: PromoteMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.restrictProject(
      companyId,
      workspaceId,
      projectId,
      dto.userId,
      user.id,
    );
  }

  @Delete('workspaces/:workspaceId/projetos/:projectId/restrict/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover restrição de acesso de um usuário a um projeto' })
  @ApiResponse({ status: 204, description: 'Restrição removida' })
  async unrestrictProject(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.empresaService.unrestrictProject(companyId, workspaceId, projectId, userId, user.id);
  }

  @Post('workspaces/:workspaceId/projetos/:projectId/admins')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Promover usuário a gerente de projeto' })
  @ApiResponse({ status: 201, description: 'Gerente de projeto definido' })
  setProjectAdmin(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Body() dto: PromoteMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.setProjectAdmin(
      companyId,
      workspaceId,
      projectId,
      dto.userId,
      user.id,
    );
  }

  @Delete('workspaces/:workspaceId/projetos/:projectId/admins/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revogar papel de gerente de projeto' })
  @ApiResponse({ status: 204, description: 'Papel revogado' })
  async revokeProjectAdmin(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.empresaService.revokeProjectAdmin(
      companyId,
      workspaceId,
      projectId,
      userId,
      user.id,
    );
  }

  @Post('workspaces/:workspaceId/membros')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Adicionar membro a um workspace da empresa' })
  @ApiResponse({ status: 201, description: 'Membro adicionado ao workspace' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  @ApiResponse({ status: 409, description: 'Usuário já é membro deste workspace' })
  addWorkspaceMember(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: PromoteMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.addWorkspaceMember(companyId, workspaceId, dto.userId, user.id);
  }

  @Delete('workspaces/:workspaceId/membros/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover membro de um workspace da empresa' })
  @ApiResponse({ status: 204, description: 'Membro removido do workspace' })
  @ApiResponse({ status: 400, description: 'Não é possível remover a si mesmo' })
  @ApiResponse({ status: 403, description: 'Revogue o papel de workspace_admin antes de remover' })
  @ApiResponse({ status: 404, description: 'Workspace ou membro não encontrado' })
  async removeWorkspaceMember(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.empresaService.removeWorkspaceMember(companyId, workspaceId, userId, user.id);
  }

  @Post('workspaces/:workspaceId/admins')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Promover usuário a workspace_admin' })
  @ApiResponse({ status: 201, description: 'Usuário promovido a workspace_admin' })
  @ApiResponse({ status: 404, description: 'Workspace ou usuário não encontrado' })
  @ApiResponse({ status: 409, description: 'Usuário já é workspace_admin' })
  promoteToWorkspaceAdmin(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: PromoteMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.empresaService.promoteToWorkspaceAdmin(companyId, workspaceId, dto.userId, user.id);
  }

  @Delete('workspaces/:workspaceId/admins/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revogar papel de workspace_admin' })
  @ApiResponse({ status: 204, description: 'Papel de workspace_admin revogado' })
  @ApiResponse({ status: 404, description: 'Admin de workspace não encontrado' })
  async revokeWorkspaceAdmin(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.empresaService.revokeWorkspaceAdmin(companyId, workspaceId, userId, user.id);
  }
}
