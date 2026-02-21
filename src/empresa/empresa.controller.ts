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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { CompanyAdminGuard } from './guards/company-admin.guard';
import { EmpresaService } from './empresa.service';
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
  listWorkspaces(
    @Param('companyId') companyId: string,
    @Query() query: ListWorkspacesQueryDto,
  ) {
    return this.empresaService.listWorkspaces(companyId, query);
  }

  @Get('workspaces/:workspaceId')
  @ApiOperation({ summary: 'Detalhes de um workspace' })
  @ApiResponse({ status: 200, description: 'Workspace encontrado' })
  @ApiResponse({ status: 404, description: 'Workspace não encontrado' })
  getWorkspace(
    @Param('companyId') companyId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
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

  @Get('membros')
  @ApiOperation({ summary: 'Listar membros da empresa com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de membros' })
  listMembers(
    @Param('companyId') companyId: string,
    @Query() query: ListMembersQueryDto,
  ) {
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
  @ApiOperation({ summary: 'Revogar papel de administrador' })
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
}
