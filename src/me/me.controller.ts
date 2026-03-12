import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { MeService } from './me.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get('perfil')
  @ApiOperation({ summary: 'Retornar dados do perfil do usuário autenticado' })
  @ApiResponse({ status: 200, description: 'Dados do perfil' })
  getProfile(@CurrentUser() user: AuthUser) {
    return this.meService.getProfile(user.id);
  }

  @Patch('perfil')
  @ApiOperation({ summary: 'Atualizar dados do perfil (nome, telefone, foto)' })
  @ApiResponse({ status: 200, description: 'Perfil atualizado' })
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.meService.updateProfile(user.id, dto);
  }

  @Patch('perfil/senha')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Alterar senha com confirmação da senha atual' })
  @ApiResponse({ status: 204, description: 'Senha alterada com sucesso' })
  @ApiResponse({ status: 401, description: 'Senha atual incorreta' })
  updatePassword(@CurrentUser() user: AuthUser, @Body() dto: UpdatePasswordDto) {
    return this.meService.updatePassword(user.id, dto);
  }

  @Get('empresas')
  @ApiOperation({ summary: 'Listar empresas que o usuário administra' })
  @ApiResponse({ status: 200, description: 'Lista de empresas do usuário autenticado' })
  getMyCompanies(@CurrentUser() user: AuthUser) {
    return this.meService.getMyCompanies(user.id);
  }

  @Get('workspaces')
  @ApiOperation({ summary: 'Listar workspaces do usuário (qualquer role)' })
  @ApiResponse({ status: 200, description: 'Lista de workspaces do usuário autenticado' })
  getMyWorkspaces(@CurrentUser() user: AuthUser) {
    return this.meService.getMyWorkspaces(user.id);
  }
}
