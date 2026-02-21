import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { MeService } from './me.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get('empresas')
  @ApiOperation({ summary: 'Listar empresas que o usuário administra' })
  @ApiResponse({ status: 200, description: 'Lista de empresas do usuário autenticado' })
  getMyCompanies(@CurrentUser() user: AuthUser) {
    return this.meService.getMyCompanies(user.id);
  }
}
