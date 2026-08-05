import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { ConsumeFirstAccessDto } from './dto/consume-first-access.dto';
import { ConfirmResetPasswordDto } from './dto/confirm-reset-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterColaboradorDto } from './dto/register-colaborador.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { AuthUser } from './strategies/jwt.strategy';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Auto-cadastro de empresa (self-service) — inicia trial de 7 dias' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: 201,
    description: 'Empresa criada em trial; link de ativação enviado por e-mail',
  })
  @ApiResponse({ status: 404, description: 'Auto-cadastro desabilitado' })
  @ApiResponse({ status: 409, description: 'CNPJ ou e-mail já cadastrado' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('register-colaborador')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Auto-cadastro de colaborador (self-service) — conta sem empresa, entra por convite',
  })
  @ApiBody({ type: RegisterColaboradorDto })
  @ApiResponse({
    status: 201,
    description: 'Se o e-mail estiver livre, a conta é criada e o link de ativação é enviado',
  })
  @ApiResponse({ status: 404, description: 'Auto-cadastro desabilitado' })
  registerColaborador(@Body() dto: RegisterColaboradorDto) {
    return this.authService.registerColaborador(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout — encerra a sessão única do usuário' })
  @ApiResponse({ status: 200, description: 'Logout realizado' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  logout(@Request() req: { user: AuthUser }) {
    return this.authService.logout(req.user.id);
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
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
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
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redefinir senha via token de email' })
  @ApiResponse({ status: 200, description: 'Senha redefinida com sucesso' })
  @ApiResponse({ status: 400, description: 'Token inválido ou expirado / senhas não coincidem' })
  async confirmResetPassword(@Param('token') token: string, @Body() dto: ConfirmResetPasswordDto) {
    await this.authService.confirmResetPassword(token, dto);
    return { message: 'ok' };
  }

  @Public()
  @Get('first-access')
  @ApiOperation({ summary: 'Validar token de primeiro acesso (sem consumir)' })
  @ApiResponse({ status: 200, description: 'Token válido — retorna email do usuário' })
  @ApiResponse({ status: 400, description: 'Token inválido ou expirado' })
  async validateFirstAccessToken(@Query('token') token: string) {
    return this.authService.validateFirstAccessToken(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('first-access')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consumir token de primeiro acesso — define nome e senha, retorna JWT' })
  @ApiResponse({ status: 200, description: 'Primeiro acesso concluído — JWT retornado' })
  @ApiResponse({ status: 400, description: 'Token inválido ou expirado / senhas não coincidem' })
  async consumeFirstAccessToken(@Query('token') token: string, @Body() dto: ConsumeFirstAccessDto) {
    return this.authService.consumeFirstAccessToken(token, dto);
  }
}
