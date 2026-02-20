import { Body, Controller, HttpCode, HttpStatus, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { AuthUser } from './strategies/jwt.strategy';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login com email e senha' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'JWT retornado com dados do usuário' })
  @ApiResponse({ status: 401, description: 'Credenciais inválidas' })
  login(@Request() req: { user: AuthUser }) {
    return this.authService.login(req.user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout (stateless — invalida sessão no cliente)' })
  @ApiResponse({ status: 200, description: 'Logout realizado' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  logout() {
    return { message: 'ok' };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Redefinir senha do usuário autenticado' })
  @ApiResponse({ status: 200, description: 'Senha redefinida com sucesso' })
  @ApiResponse({ status: 400, description: 'As senhas não coincidem' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  async resetPassword(@CurrentUser() user: AuthUser, @Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(user.id, dto);
    return { message: 'ok' };
  }
}
