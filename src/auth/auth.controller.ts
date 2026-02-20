import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { ConfirmResetPasswordDto } from './dto/confirm-reset-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
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
  @ApiOperation({ summary: 'Redefinir senha do usuário autenticado (primeiro acesso)' })
  @ApiResponse({ status: 200, description: 'Senha redefinida com sucesso' })
  @ApiResponse({ status: 400, description: 'As senhas não coincidem' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  async resetPassword(@CurrentUser() user: AuthUser, @Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(user.id, dto);
    return { message: 'ok' };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solicitar redefinição de senha via email' })
  @ApiResponse({
    status: 200,
    description: 'Se o email existir, um link de redefinição será enviado',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
    return { message: 'ok' };
  }

  @Public()
  @Post('reset-password/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redefinir senha via token de email' })
  @ApiResponse({ status: 200, description: 'Senha redefinida com sucesso' })
  @ApiResponse({ status: 400, description: 'Token inválido ou expirado / senhas não coincidem' })
  async confirmResetPassword(@Param('token') token: string, @Body() dto: ConfirmResetPasswordDto) {
    await this.authService.confirmResetPassword(token, dto);
    return { message: 'ok' };
  }
}
