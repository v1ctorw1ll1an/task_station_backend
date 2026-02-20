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

  @Patch('empresas/:id')
  @ApiOperation({ summary: 'Editar razão social ou CNPJ da empresa' })
  @ApiResponse({ status: 200, description: 'Empresa atualizada' })
  @ApiResponse({ status: 404, description: 'Empresa não encontrada' })
  @ApiResponse({ status: 409, description: 'CNPJ já cadastrado' })
  updateCompany(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
    return this.superadminService.updateCompany(id, dto);
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

  // ── Usuários ─────────────────────────────────────────────────────────────────

  @Get('usuarios')
  @ApiOperation({ summary: 'Listar todos os usuários com filtros e paginação' })
  @ApiResponse({ status: 200, description: 'Lista paginada de usuários' })
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.superadminService.listUsers(query);
  }

  @Patch('usuarios/:id')
  @ApiOperation({ summary: 'Inativar ou reativar usuário' })
  @ApiResponse({ status: 200, description: 'Usuário atualizado' })
  @ApiResponse({ status: 400, description: 'Não é possível alterar o próprio usuário' })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser) {
    return this.superadminService.updateUser(id, dto, user.id);
  }
}
