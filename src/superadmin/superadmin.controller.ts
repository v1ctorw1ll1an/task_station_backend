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
import { SuperuserGuard } from './guards/superuser.guard';
import { SuperadminService } from './superadmin.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@ApiTags('superadmin')
@ApiBearerAuth()
@UseGuards(SuperuserGuard)
@Controller('superadmin')
export class SuperadminController {
  constructor(private readonly superadminService: SuperadminService) {}

  // ── Empresas ────────────────────────────────────────────────────────────────

  @Post('empresas')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar empresa e admin inicial' })
  @ApiResponse({ status: 201, description: 'Empresa criada com sucesso' })
  @ApiResponse({ status: 409, description: 'CNPJ ou email já cadastrado' })
  createCompany(@Body() dto: CreateCompanyDto, @CurrentUser() user: AuthUser) {
    return this.superadminService.createCompany(dto, user.id);
  }

  @Get('empresas')
  @ApiOperation({ summary: 'Listar empresas com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de empresas' })
  listCompanies(@Query() query: ListCompaniesQueryDto) {
    return this.superadminService.listCompanies(query);
  }

  @Get('empresas/:id')
  @ApiOperation({ summary: 'Detalhes da empresa com admins e métricas' })
  @ApiResponse({ status: 200, description: 'Detalhes da empresa' })
  @ApiResponse({ status: 404, description: 'Empresa não encontrada' })
  getCompanyDetail(@Param('id') id: string) {
    return this.superadminService.getCompanyDetail(id);
  }

  @Patch('empresas/:id')
  @ApiOperation({ summary: 'Editar razão social ou CNPJ da empresa' })
  @ApiResponse({ status: 200, description: 'Empresa atualizada' })
  @ApiResponse({ status: 404, description: 'Empresa não encontrada' })
  @ApiResponse({ status: 409, description: 'CNPJ já cadastrado' })
  updateCompany(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
    return this.superadminService.updateCompany(id, dto);
  }

  @Patch('empresas/:id/membros/:membershipId/inativar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Inativar vínculo de admin com empresa' })
  @ApiResponse({ status: 204, description: 'Vínculo inativado' })
  @ApiResponse({ status: 400, description: 'Não pode inativar único admin' })
  @ApiResponse({ status: 404, description: 'Vínculo não encontrado' })
  async deactivateMembership(
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.superadminService.deactivateMembership(id, membershipId, user.id);
  }

  @Patch('empresas/:id/inativar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inativar empresa' })
  @ApiResponse({ status: 200, description: 'Empresa inativada' })
  @ApiResponse({ status: 404, description: 'Empresa não encontrada' })
  deactivateCompany(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.superadminService.deactivateCompany(id, user.id);
  }

  @Delete('empresas/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete de empresa' })
  @ApiResponse({ status: 204, description: 'Empresa removida' })
  @ApiResponse({ status: 404, description: 'Empresa não encontrada' })
  async deleteCompany(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.superadminService.deleteCompany(id, user.id);
  }

  // ── Perfil ───────────────────────────────────────────────────────────────────

  @Patch('perfil')
  @ApiOperation({ summary: 'Atualizar dados do próprio perfil (superusuário)' })
  @ApiResponse({ status: 200, description: 'Perfil atualizado' })
  @ApiResponse({ status: 409, description: 'Email já cadastrado' })
  updateProfile(@Body() dto: UpdateProfileDto, @CurrentUser() user: AuthUser) {
    return this.superadminService.updateProfile(user.id, dto);
  }

  // ── Usuários ─────────────────────────────────────────────────────────────────

  @Get('usuarios')
  @ApiOperation({ summary: 'Listar todos os usuários com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de usuários' })
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.superadminService.listUsers(query);
  }

  @Get('usuarios/:id')
  @ApiOperation({ summary: 'Detalhes de um usuário com empresas vinculadas' })
  @ApiResponse({ status: 200, description: 'Detalhes do usuário' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  getUserDetail(@Param('id') id: string) {
    return this.superadminService.getUserDetail(id);
  }

  @Patch('usuarios/:id')
  @ApiOperation({ summary: 'Inativar ou reativar usuário' })
  @ApiResponse({ status: 200, description: 'Usuário atualizado' })
  @ApiResponse({ status: 400, description: 'Não é possível alterar o próprio usuário' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser) {
    return this.superadminService.updateUser(id, dto, user.id);
  }

  @Post('usuarios/:id/invalidar-credenciais')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invalidar credenciais do usuário e gerar novo magic link' })
  @ApiResponse({ status: 200, description: 'Credenciais invalidadas — magic link gerado' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  invalidateUserCredentials(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.superadminService.invalidateUserCredentials(id, user.id);
  }

  @Get('usuarios/:id/magic-link')
  @ApiOperation({ summary: 'Obter (ou regenerar) magic link de primeiro acesso do usuário' })
  @ApiResponse({
    status: 200,
    description: 'Magic link — null se usuário não tem mustResetPassword',
  })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  getMagicLink(@Param('id') id: string) {
    return this.superadminService.getMagicLink(id);
  }
}
